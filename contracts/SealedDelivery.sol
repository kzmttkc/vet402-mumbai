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
 * before paying; coverage can change and claims can reserve zero. Silence costs the seller 2x the value,
 * capped by coverage: the buyer gets half rounded up and the other half is burned to 0xdEaD. A seller
 * paying itself through a second address loses half of what it pulls (rounded down), while using
 * requestWithdraw and withdrawing after the cooldown costs nothing in collateral penalties. Only EOA
 * signatures are accepted. There is no owner, administrator, upgrade mechanism, or native-token entry.
 * Each seller-signed Promise is bound to one buyer. Claims are keyed by
 * claimId = keccak256(abi.encode(seller, buyer, paymentNonce)), so the same nonce under another seller
 * or buyer is a separate claim and a stranger cannot block the real buyer.
 * A delivered claim's fraud payout is capped by the seller's unreserved deposit, including funds
 * queued for withdrawal that have not yet left during the cooldown. Queuing a withdrawal does not
 * shield a seller from a fraud proof made inside the cooldown. A proof made after the seller has
 * completed the withdrawal can only be paid from what is left.
 */
contract SealedDelivery is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public constant USDC = IERC20(0x3600000000000000000000000000000000000000);
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
    uint256 internal constant PAYMENT_CHAIN_ID = 5042002;
    address internal constant PAYMENT_VERIFYING_CONTRACT = 0x0077777d7EBA4688BDeF3E311b846F25870A19B9;
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
        uint256 reserved;
        uint64 deadline;
        bytes32 keyHash;
        Status status;
        bytes32 paymentNonce;
        bytes32 plaintextHash;
        bytes32 ciphertextHash;
    }

    mapping(address => uint256) public deposits;
    mapping(address => uint256) public reserved;
    mapping(address => uint256) public pendingWithdrawal;
    mapping(address => uint256) public withdrawReadyAt;
    mapping(address => uint256) public claimable;
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
    error TimestampOverflow();

    event Claimed(bytes32 indexed claimId, bytes32 indexed paymentNonce, address indexed seller, address buyer, uint256 reserved, uint64 deadline);
    event KeyRevealed(bytes32 indexed claimId, bytes32 indexed paymentNonce, bytes key);
    /// @notice paidOut is the buyer's credit; the burned half is visible as a USDC Transfer to DEAD.
    event Silent(bytes32 indexed claimId, bytes32 indexed paymentNonce, address indexed seller, address buyer, uint256 paidOut);
    /// @notice paidOut is the buyer's credit; the burned half is visible as a USDC Transfer to DEAD.
    event Fraud(bytes32 indexed claimId, bytes32 indexed paymentNonce, address indexed seller, address buyer, uint256 paidOut);
    event Deposited(address indexed seller, uint256 amount);
    event WithdrawalRequested(address indexed seller, uint256 amount, uint256 readyAt);
    event DepositWithdrawn(address indexed seller, uint256 amount);
    event ClaimableWithdrawn(address indexed buyer, uint256 amount);

    /// @notice Sets immutable dispute timing; seller withdrawals must outwait expiry plus the answer window.
    /// @dev Gateway settlement remains entirely separate from the seller's deposit.
    constructor(uint256 maxExpiry, uint256 answerWindow, uint256 cooldown) EIP712("SealedDelivery", "1") {
        if (maxExpiry == 0) revert InvalidMaxExpiry();
        if (answerWindow == 0) revert InvalidAnswerWindow();
        // Subtraction avoids overflowing maxExpiry + answerWindow for invalid configurations.
        if (cooldown < maxExpiry || cooldown - maxExpiry < answerWindow) revert InvalidCooldown();
        MAX_EXPIRY = maxExpiry;
        ANSWER_WINDOW = answerWindow;
        COOLDOWN = cooldown;
        PAYMENT_DOMAIN_SEPARATOR = keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256("GatewayWalletBatched"),
            keccak256("1"),
            PAYMENT_CHAIN_ID,
            PAYMENT_VERIFYING_CONTRACT
        ));
    }

    /// @notice Returns unreserved, non-withdrawing deposit coverage that a buyer can inspect before paying.
    /// @dev Coverage is not a guarantee of future availability or proof of Gateway settlement.
    function coverage(address seller) public view returns (uint256) {
        uint256 balance = deposits[seller];
        uint256 locked = reserved[seller];
        if (locked > balance) return 0;
        uint256 available = balance - locked;
        uint256 pending = pendingWithdrawal[seller];
        return pending > available ? 0 : available - pending;
    }

    /// @notice A buyer reads this before paying to check coverage for twice the payment value.
    /// @dev Coverage can change before a claim; values whose double exceeds uint256 return false.
    function coverageFor(address seller, uint256 value) public view returns (bool) {
        if (value > type(uint256).max / 2) return false;
        return coverage(seller) >= 2 * value;
    }

    /// @notice Reserves available seller collateral against a signed key-revelation promise bound to one buyer.
    /// @dev Checks signed buyer intent only, not settlement or authorization validity times. Zero coverage
    /// still records a claim; each claimId is single-use on this contract.
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
        uint256 r;
        {
            uint256 available = coverage(p.seller);
            uint256 wanted = p.value > type(uint256).max / 2 ? type(uint256).max : 2 * p.value;
            r = wanted < available ? wanted : available;
        }
        reserved[p.seller] += r;
        Claim storage c = claims[claimId];
        c.seller = p.seller;
        c.buyer = msg.sender;
        c.reserved = r;
        c.deadline = deadline;
        c.keyHash = p.keyHash;
        c.status = Status.OPEN;
        c.paymentNonce = p.paymentNonce;
        c.plaintextHash = p.plaintextHash;
        c.ciphertextHash = p.ciphertextHash;
        emit Claimed(claimId, p.paymentNonce, p.seller, msg.sender, r, deadline);
    }

    /// @notice Anyone may reveal the promised key before the deadline, releasing the seller's reservation.
    /// @dev A matching key does not prove plaintext correctness or that the buyer's payment settled.
    /// @param claimId Identifier derived from the seller, buyer, and payment nonce.
    function answer(bytes32 claimId, bytes calldata key) external {
        Claim storage c = claims[claimId];
        if (c.status != Status.OPEN) revert NotOpen();
        if (block.timestamp >= c.deadline) revert AnswerWindowClosed();
        if (keccak256(abi.encodePacked(key)) != c.keyHash) revert WrongKey();
        c.status = Status.DELIVERED;
        reserved[c.seller] -= c.reserved;
        emit KeyRevealed(claimId, c.paymentNonce, key);
    }

    /// @notice Anyone may finalize silence at or after the deadline, crediting the buyer from the deposit.
    /// @dev Silence costs 2x the value capped by coverage reserved at claim time, regardless of settlement.
    /// The buyer gets half rounded up; the remainder is burned to 0xdEaD via a USDC transfer to DEAD.
    /// Silent.paidOut reports only the buyer's credit, not the burned half.
    /// @param claimId Identifier derived from the seller, buyer, and payment nonce.
    function finalize(bytes32 claimId) external nonReentrant {
        Claim storage c = claims[claimId];
        if (c.status != Status.OPEN) revert NotOpen();
        if (block.timestamp < c.deadline) revert DeadlineNotReached();
        uint256 r = c.reserved;
        // Equivalent to (r + 1) / 2 without overflowing when r is uint256.max.
        uint256 paidOut = r / 2 + r % 2;
        uint256 burned = r - paidOut;
        c.status = Status.SILENT;
        deposits[c.seller] -= r;
        reserved[c.seller] -= r;
        claimable[c.buyer] += paidOut;
        silentCount[c.seller] += 1;
        if (burned > 0) USDC.safeTransfer(DEAD, burned);
        emit Silent(claimId, c.paymentNonce, c.seller, c.buyer, paidOut);
    }

    /// @notice Anyone holding the key and ciphertext can prove onchain that the delivered plaintext
    /// does not match the seller's signed plaintextHash, on an OPEN or DELIVERED claim at any time.
    /// @dev A kept promise reverts, costing the caller only gas. Fraud credits half rounded up to the
    /// buyer and burns the remainder to DEAD. A delivered claim's fraud payout is capped by the seller's
    /// unreserved deposit, including funds queued for withdrawal that have not yet left during the
    /// cooldown, so queuing a withdrawal does not shield a seller from a fraud proof inside the cooldown.
    /// A proof made after the seller has completed the withdrawal can only be paid from what is left.
    function prove(bytes32 claimId, bytes calldata ciphertext, bytes calldata key) external nonReentrant {
        Claim storage c = claims[claimId];
        Status status = c.status;
        if (status == Status.FRAUD) revert AlreadyFraud();
        if (status != Status.OPEN && status != Status.DELIVERED) revert NotProvable();
        if (keccak256(abi.encodePacked(key)) != c.keyHash) revert WrongKey();
        if (keccak256(ciphertext) != c.ciphertextHash) revert WrongCiphertext();
        if (_plaintextHash(ciphertext, key) == c.plaintextHash) revert PromiseKept();

        uint256 amount = c.reserved;
        if (status == Status.OPEN) {
            reserved[c.seller] -= amount;
        } else {
            uint256 backing = deposits[c.seller] - reserved[c.seller];
            if (amount > backing) amount = backing;
            uint256 free = coverage(c.seller);
            if (amount > free) {
                uint256 overlap = amount - free;
                pendingWithdrawal[c.seller] -= overlap;
                if (pendingWithdrawal[c.seller] == 0) withdrawReadyAt[c.seller] = 0;
            }
        }
        // Equivalent to (amount + 1) / 2 without overflowing at uint256.max.
        uint256 paidOut = amount / 2 + amount % 2;
        uint256 burned = amount - paidOut;
        c.status = Status.FRAUD;
        deposits[c.seller] -= amount;
        claimable[c.buyer] += paidOut;
        fraudCount[c.seller] += 1;
        if (burned > 0) USDC.safeTransfer(DEAD, burned);
        emit Fraud(claimId, c.paymentNonce, c.seller, c.buyer, paidOut);
    }

    /// @notice Adds USDC collateral backing the caller's key-revelation promises, not any buyer payment.
    /// @dev Requires prior USDC approval; amounts are in six-decimal USDC base units.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        deposits[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice Queues uncovered seller collateral for withdrawal after the full immutable cooldown.
    /// @dev Excludes reservations and earlier requests; adding a request restarts the whole pending cooldown.
    function requestWithdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (amount > coverage(msg.sender)) revert ExceedsCoverage();
        pendingWithdrawal[msg.sender] += amount;
        uint256 readyAt = block.timestamp + COOLDOWN;
        withdrawReadyAt[msg.sender] = readyAt;
        emit WithdrawalRequested(msg.sender, amount, readyAt);
    }

    /// @notice Pulls the caller's pending seller deposit only after its cooldown has elapsed.
    /// @dev Reserved collateral cannot be withdrawn; state is cleared before the USDC transfer.
    function withdrawDeposit() external nonReentrant {
        uint256 amt = pendingWithdrawal[msg.sender];
        if (amt == 0) revert NothingPending();
        if (block.timestamp < withdrawReadyAt[msg.sender]) revert CooldownActive();
        pendingWithdrawal[msg.sender] = 0;
        withdrawReadyAt[msg.sender] = 0;
        deposits[msg.sender] -= amt;
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

    /// @dev Uses the fixed Gateway domain, never this deployment's chain ID or an external domain call.
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
