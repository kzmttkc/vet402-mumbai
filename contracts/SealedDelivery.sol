// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SealedDelivery
 * @notice Seller-funded key-revelation disputes for payments settled separately through Gateway.
 * @dev Never receives or verifies the underlying payment: buyer signatures prove intent, not settlement.
 * Deposits back key revelation and signed plaintext correctness. Buyers should read coverageFor(seller, value)
 * before paying. Nothing is reserved at claim time: a verdict (finalize or prove) takes
 * min(2 * value, deposits[seller]) when it lands, so earlier verdicts are paid first and later ones get
 * what is left. The buyer gets half rounded up and the remainder queues in pendingBurn until anyone calls
 * flushBurn(), so a blocked burn address cannot stop a verdict. Funds queued for withdrawal stay in
 * deposits and can be taken until they actually leave. openLiability[seller] holds withdrawals back while
 * claims are unresolved; it never blocks a claim or another buyer's verdict. A seller paying itself through
 * a second address loses half of what it pulls (rounded down). Only EOA signatures are accepted. There is
 * no owner, administrator, upgrade mechanism, or native-token entry.
 * Each seller-signed Promise is bound to one buyer. Claims are keyed by
 * claimId = keccak256(abi.encode(seller, buyer, paymentNonce)), so the same nonce under another seller
 * or buyer is a separate claim and a stranger cannot block the real buyer.
 * A fraud proof made after the seller has completed a withdrawal can only be paid from what is left.
 */
contract SealedDelivery is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDC;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public immutable MAX_EXPIRY;
    uint256 public immutable ANSWER_WINDOW;
    uint256 public immutable COOLDOWN;

    bytes32 internal constant PROMISE_TYPEHASH = keccak256(
        "Promise(address seller,uint256 value,bytes32 paymentNonce,bytes32 keyHash,bytes32 plaintextHash,bytes32 ciphertextHash,uint64 expiry,address buyer)"
    );
    bytes32 internal constant PAYMENT_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    /// @dev Gateway's version 2 domain adds a salt: the asset address left-padded to 32 bytes.
    bytes32 internal constant SALTED_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)"
    );
    /// @dev Caps one claim's liability so that the openLiability sum cannot overflow: that would take
    /// 2^128 claims. Without it a seller-signed huge value would make every later claim revert.
    uint256 internal constant LIABILITY_CAP = type(uint128).max;
    bytes32 internal immutable PAYMENT_DOMAIN_SEPARATOR;

    /// @notice Seller-signed key-revelation promise bound to one buyer.
    struct Promise {
        address seller;
        uint256 value;
        bytes32 paymentNonce;
        bytes32 keyHash;
        bytes32 plaintextHash;
        bytes32 ciphertextHash;
        uint64 expiry;
        address buyer;
    }

    struct PaymentAuth {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    enum Status { NONE, OPEN, DELIVERED, SILENT, FRAUD }

    struct Claim {
        address seller;
        address buyer;
        uint256 liability;
        uint64 deadline;
        bytes32 keyHash;
        Status status;
        bytes32 paymentNonce;
        bytes32 plaintextHash;
        bytes32 ciphertextHash;
    }

    mapping(address => uint256) public deposits;
    mapping(address => uint256) public openLiability;
    mapping(address => uint256) public pendingWithdrawal;
    mapping(address => uint256) public withdrawReadyAt;
    mapping(address => uint256) public claimable;
    uint256 public pendingBurn;
    mapping(address => uint256) public silentCount;
    mapping(address => uint256) public fraudCount;
    mapping(bytes32 claimId => Claim) public claims;

    error InvalidMaxExpiry();
    error InvalidAnswerWindow();
    error InvalidCooldown();
    error InvalidSellerSignature();
    error InvalidBuyerSignature();
    error NotBuyer();
    error WrongBuyer();
    error WrongPayee();
    error WrongValue();
    error WrongNonce();
    error PromiseExpired();
    error ExpiryTooFar();
    error AlreadyClaimed();
    error NotOpen();
    error AnswerWindowClosed();
    error WrongKey();
    error NotProvable();
    error AlreadyFraud();
    error WrongCiphertext();
    error PromiseKept();
    error DeadlineNotReached();
    error ZeroAmount();
    error ExceedsCoverage();
    error NothingPending();
    error CooldownActive();
    error NothingToWithdraw();
    error LiabilityOpen();
    error TimestampOverflow();

    event Claimed(bytes32 indexed claimId, bytes32 indexed paymentNonce, address indexed seller, address buyer, uint256 liability, uint64 deadline);
    event KeyRevealed(bytes32 indexed claimId, bytes32 indexed paymentNonce, bytes key);
    /// @notice paidOut is the buyer's credit; the rest of the payout joins pendingBurn.
    event Silent(bytes32 indexed claimId, bytes32 indexed paymentNonce, address indexed seller, address buyer, uint256 paidOut);
    /// @notice paidOut is the buyer's credit; the rest of the payout joins pendingBurn.
    event Fraud(bytes32 indexed claimId, bytes32 indexed paymentNonce, address indexed seller, address buyer, uint256 paidOut);
    event Deposited(address indexed seller, uint256 amount);
    event WithdrawalRequested(address indexed seller, uint256 amount, uint256 readyAt);
    event DepositWithdrawn(address indexed seller, uint256 amount);
    event ClaimableWithdrawn(address indexed buyer, uint256 amount);
    event BurnFlushed(uint256 amount);

    /// @notice Sets immutable dispute timing, the collateral token and the buyer's payment signing domain.
    /// @dev Seller withdrawals must outwait expiry plus the answer window. Gateway settlement stays separate
    /// from the deposit. The payment domain's chain ID is this deployment's: Gateway signs for the chain the
    /// buyer pays on, so deploy on that chain. A domain version of "2" uses Gateway's salted form.
    constructor(
        uint256 maxExpiry,
        uint256 answerWindow,
        uint256 cooldown,
        address usdc,
        string memory paymentDomainName,
        string memory paymentDomainVersion,
        address paymentVerifyingContract
    ) EIP712("SealedDelivery", "1") {
        if (maxExpiry == 0) revert InvalidMaxExpiry();
        if (answerWindow == 0) revert InvalidAnswerWindow();
        // Subtraction avoids overflowing maxExpiry + answerWindow for invalid configurations.
        if (cooldown < maxExpiry || cooldown - maxExpiry < answerWindow) revert InvalidCooldown();
        MAX_EXPIRY = maxExpiry;
        ANSWER_WINDOW = answerWindow;
        COOLDOWN = cooldown;
        USDC = IERC20(usdc);
        bytes32 nameHash = keccak256(bytes(paymentDomainName));
        bytes32 versionHash = keccak256(bytes(paymentDomainVersion));
        PAYMENT_DOMAIN_SEPARATOR = versionHash == keccak256("2")
            ? keccak256(abi.encode(
                SALTED_DOMAIN_TYPEHASH, nameHash, versionHash, block.chainid, paymentVerifyingContract,
                bytes32(uint256(uint160(usdc)))
            ))
            : keccak256(abi.encode(DOMAIN_TYPEHASH, nameHash, versionHash, block.chainid, paymentVerifyingContract));
    }

    /// @notice Returns the deposit not queued for withdrawal, for a buyer to read before paying.
    /// @dev Open claims do not lower it (see openLiability) and it is no guarantee of future availability
    /// or proof of Gateway settlement.
    function coverage(address seller) public view returns (uint256) {
        return deposits[seller] - pendingWithdrawal[seller];
    }

    /// @notice A buyer reads this before paying to check coverage for twice the payment value.
    /// @dev Coverage can change before a claim; values whose double exceeds uint256 return false.
    function coverageFor(address seller, uint256 value) public view returns (bool) {
        if (value > type(uint256).max / 2) return false;
        return coverage(seller) >= 2 * value;
    }

    /// @notice Records a signed key-revelation promise bound to one buyer; moves no funds and reserves none.
    /// @dev Checks signed buyer intent only, not settlement or authorization validity times. Zero coverage
    /// still records a claim; each claimId is single-use on this contract. Holds the seller's withdrawals
    /// back by the claim's liability until it resolves.
    function claim(
        Promise calldata p,
        bytes calldata sellerSignature,
        PaymentAuth calldata auth,
        bytes calldata buyerSignature
    ) external {
        if (!_isValidSignature(_promiseDigest(p), sellerSignature, p.seller)) revert InvalidSellerSignature();
        if (!_isValidSignature(_paymentDigest(auth), buyerSignature, auth.from)) revert InvalidBuyerSignature();
        if (msg.sender != auth.from) revert NotBuyer();
        if (p.buyer != auth.from) revert WrongBuyer();
        if (auth.to != p.seller) revert WrongPayee();
        if (auth.value != p.value) revert WrongValue();
        if (auth.nonce != p.paymentNonce) revert WrongNonce();
        if (block.timestamp >= p.expiry) revert PromiseExpired();
        if (uint256(p.expiry) - block.timestamp > MAX_EXPIRY) revert ExpiryTooFar();
        bytes32 claimId = _claimId(p.seller, p.buyer, p.paymentNonce);
        if (claims[claimId].status != Status.NONE) revert AlreadyClaimed();
        if (block.timestamp > type(uint64).max || ANSWER_WINDOW > type(uint64).max - block.timestamp) {
            revert TimestampOverflow();
        }
        uint64 deadline = uint64(block.timestamp + ANSWER_WINDOW);
        uint256 liability = p.value > LIABILITY_CAP / 2 ? LIABILITY_CAP : 2 * p.value;
        openLiability[p.seller] += liability;
        Claim storage c = claims[claimId];
        c.seller = p.seller;
        c.buyer = msg.sender;
        c.liability = liability;
        c.deadline = deadline;
        c.keyHash = p.keyHash;
        c.status = Status.OPEN;
        c.paymentNonce = p.paymentNonce;
        c.plaintextHash = p.plaintextHash;
        c.ciphertextHash = p.ciphertextHash;
        emit Claimed(claimId, p.paymentNonce, p.seller, msg.sender, liability, deadline);
    }

    /// @notice Anyone may reveal the promised key before the deadline, releasing the claim's liability.
    /// @dev A matching key does not prove plaintext correctness or that the buyer's payment settled.
    /// @param claimId Identifier derived from the seller, buyer, and payment nonce.
    function answer(bytes32 claimId, bytes calldata key) external {
        Claim storage c = claims[claimId];
        if (c.status != Status.OPEN) revert NotOpen();
        if (block.timestamp >= c.deadline) revert AnswerWindowClosed();
        if (keccak256(abi.encodePacked(key)) != c.keyHash) revert WrongKey();
        c.status = Status.DELIVERED;
        openLiability[c.seller] -= c.liability;
        emit KeyRevealed(claimId, c.paymentNonce, key);
    }

    /// @notice Anyone may finalize silence at or after the deadline, crediting the buyer from the deposit.
    /// @dev Silence costs min(2x the value, the deposit at this moment), regardless of settlement. The buyer
    /// gets half rounded up and the remainder joins pendingBurn. Silent.paidOut reports only the buyer's credit.
    /// @param claimId Identifier derived from the seller, buyer, and payment nonce.
    function finalize(bytes32 claimId) external {
        Claim storage c = claims[claimId];
        if (c.status != Status.OPEN) revert NotOpen();
        if (block.timestamp < c.deadline) revert DeadlineNotReached();
        c.status = Status.SILENT;
        openLiability[c.seller] -= c.liability;
        silentCount[c.seller] += 1;
        uint256 paidOut = _takeFromDeposit(c.seller, c.buyer, c.liability);
        emit Silent(claimId, c.paymentNonce, c.seller, c.buyer, paidOut);
    }

    /// @notice Anyone holding the key and ciphertext can prove onchain that the delivered plaintext
    /// does not match the seller's signed plaintextHash, on an OPEN or DELIVERED claim at any time.
    /// @dev A kept promise reverts, costing the caller only gas. Fraud takes what silence takes, from the
    /// deposit at this moment and including funds queued for withdrawal. A proof made after the seller has
    /// completed the withdrawal can only be paid from what is left.
    function prove(bytes32 claimId, bytes calldata ciphertext, bytes calldata key) external {
        Claim storage c = claims[claimId];
        Status status = c.status;
        if (status == Status.FRAUD) revert AlreadyFraud();
        if (status != Status.OPEN && status != Status.DELIVERED) revert NotProvable();
        if (keccak256(abi.encodePacked(key)) != c.keyHash) revert WrongKey();
        if (keccak256(ciphertext) != c.ciphertextHash) revert WrongCiphertext();
        if (_plaintextHash(ciphertext, key) == c.plaintextHash) revert PromiseKept();

        c.status = Status.FRAUD;
        // A DELIVERED claim released its liability when it was answered.
        if (status == Status.OPEN) openLiability[c.seller] -= c.liability;
        fraudCount[c.seller] += 1;
        uint256 paidOut = _takeFromDeposit(c.seller, c.buyer, c.liability);
        emit Fraud(claimId, c.paymentNonce, c.seller, c.buyer, paidOut);
    }

    /// @notice Sends the burned share of past verdicts to 0xdEaD. Anyone may call it.
    /// @dev Verdicts never depend on this transfer; if it fails the amount simply stays in pendingBurn.
    function flushBurn() external nonReentrant {
        uint256 amt = pendingBurn;
        if (amt == 0) revert NothingToWithdraw();
        pendingBurn = 0;
        USDC.safeTransfer(DEAD, amt);
        emit BurnFlushed(amt);
    }

    /// @notice Adds USDC collateral backing the caller's key-revelation promises, not any buyer payment.
    /// @dev Requires prior USDC approval; amounts are in six-decimal USDC base units.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        deposits[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice Queues seller collateral for withdrawal after the full immutable cooldown.
    /// @dev Queued funds leave coverage at once but stay in deposits, and verdicts can still take them, until
    /// withdrawDeposit runs. Adding a request restarts the whole pending cooldown.
    function requestWithdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (amount > coverage(msg.sender)) revert ExceedsCoverage();
        pendingWithdrawal[msg.sender] += amount;
        uint256 readyAt = block.timestamp + COOLDOWN;
        withdrawReadyAt[msg.sender] = readyAt;
        emit WithdrawalRequested(msg.sender, amount, readyAt);
    }

    /// @notice Pulls the caller's queued deposit after its cooldown, leaving enough to cover open claims.
    /// @dev Sends min(pending, deposits - openLiability). The rest stays queued, ready to leave once the
    /// claims resolve. State is cleared before the USDC transfer.
    function withdrawDeposit() external nonReentrant {
        uint256 pending = pendingWithdrawal[msg.sender];
        if (pending == 0) revert NothingPending();
        if (block.timestamp < withdrawReadyAt[msg.sender]) revert CooldownActive();
        uint256 balance = deposits[msg.sender];
        uint256 held = openLiability[msg.sender];
        uint256 free = balance > held ? balance - held : 0;
        uint256 amt = pending < free ? pending : free;
        if (amt == 0) revert LiabilityOpen();
        pendingWithdrawal[msg.sender] = pending - amt;
        if (pending == amt) withdrawReadyAt[msg.sender] = 0;
        deposits[msg.sender] = balance - amt;
        USDC.safeTransfer(msg.sender, amt);
        emit DepositWithdrawn(msg.sender, amt);
    }

    /// @notice Pulls the caller's credits awarded for unanswered promises, not refunds from Gateway.
    /// @dev Clears the credit before transferring USDC; buyers never receive seller funds automatically.
    function withdrawClaimable() external nonReentrant {
        uint256 amt = claimable[msg.sender];
        if (amt == 0) revert NothingToWithdraw();
        claimable[msg.sender] = 0;
        USDC.safeTransfer(msg.sender, amt);
        emit ClaimableWithdrawn(msg.sender, amt);
    }

    /// @dev Takes min(amount, deposit) from the seller: half rounded up to the buyer, the rest to pendingBurn.
    /// Queued funds are not protected, so pendingWithdrawal comes down with the deposit when it has to.
    function _takeFromDeposit(address seller, address buyer, uint256 amount) private returns (uint256 paidOut) {
        uint256 balance = deposits[seller];
        uint256 payout = amount < balance ? amount : balance;
        balance -= payout;
        deposits[seller] = balance;
        if (pendingWithdrawal[seller] > balance) {
            pendingWithdrawal[seller] = balance;
            if (balance == 0) withdrawReadyAt[seller] = 0;
        }
        // Equivalent to (payout + 1) / 2 without overflowing at uint256.max.
        paidOut = payout / 2 + payout % 2;
        claimable[buyer] += paidOut;
        pendingBurn += payout - paidOut;
    }

    /// @dev Hashes plaintext from XOR with keccak256(abi.encodePacked(key, uint256(blockIndex))).
    /// Copies the arbitrary-length key once; hashes only the exact ciphertext length, excluding slack.
    function _plaintextHash(bytes calldata ciphertext, bytes calldata key) internal pure returns (bytes32 result) {
        assembly ("memory-safe") {
            // Start the key-and-index scratch allocation at the free memory pointer.
            let scratch := mload(0x40)
            // Place the 32-byte block index immediately after the arbitrary-length key.
            let indexPtr := add(scratch, key.length)
            // Hash exactly the key bytes followed by the 32-byte block index.
            let inputLength := add(key.length, 0x20)
            // Align the output buffer after the complete key-and-index scratch allocation.
            let buffer := and(add(add(indexPtr, 0x20), 0x1f), not(0x1f))
            // Cache the exact ciphertext (and plaintext) byte length.
            let length := ciphertext.length
            // Allocate length plus 32 bytes of slack, rounding the new free pointer upward.
            mstore(0x40, and(add(add(buffer, length), 0x3f), not(0x1f)))
            // Copy the key from calldata once, leaving its trailing index word for the loop.
            calldatacopy(scratch, key.offset, key.length)
            // Process one word per iteration, including a final partial word when present.
            for { let offset := 0 } lt(offset, length) { offset := add(offset, 0x20) } {
                // Append the zero-based uint256 block index in packed ABI encoding.
                mstore(indexPtr, shr(5, offset))
                // Derive this block's keystream from the key and its appended index.
                let stream := keccak256(scratch, inputLength)
                // XOR the calldata word and store it; any final excess bytes stay in allocated slack.
                mstore(add(buffer, offset), xor(calldataload(add(ciphertext.offset, offset)), stream))
            }
            // Exclude all slack and partial-word excess from the plaintext hash.
            result := keccak256(buffer, length)
        }
    }

    function _claimId(address seller, address buyer, bytes32 paymentNonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(seller, buyer, paymentNonce));
    }

    function _promiseDigest(Promise memory p) internal view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            PROMISE_TYPEHASH, p.seller, p.value, p.paymentNonce, p.keyHash,
            p.plaintextHash, p.ciphertextHash, p.expiry, p.buyer
        )));
    }

    /// @dev Uses the payment domain fixed at construction, never an external domain call.
    function _paymentDigest(PaymentAuth memory auth) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            PAYMENT_TYPEHASH, auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce
        ));
        return MessageHashUtils.toTypedDataHash(PAYMENT_DOMAIN_SEPARATOR, structHash);
    }

    /// @dev EOA-only verification; callers map all recovery failures to their specific signature errors.
    function _isValidSignature(bytes32 digest, bytes memory signature, address expectedSigner)
        internal pure returns (bool)
    {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        return err == ECDSA.RecoverError.NoError && recovered != address(0) && recovered == expectedSigner;
    }
}
