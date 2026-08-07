// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// TODO: Replace local interfaces with imports from flare-smart-contracts-v2 once published as a package.
import { ITeeExtensionRegistry } from "./interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "./interfaces/ITeeMachineRegistry.sol";

/// @title InstructionSender (sign extension)
/// @author Acex
/// @notice On-chain entry point for sending instructions to the sign-extension TEE.
///
/// DO NOT MODIFY: constructor, setExtensionId(), _getExtensionId()
contract InstructionSender {
    /// @notice Operation type for key-related actions (UPDATE, SIGN).
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_KEY = bytes32("KEY");

    /// @notice Command for the UPDATE_KEY action (stores an encrypted private key).
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_UPDATE = bytes32("UPDATE");

    /// @notice Command for the SIGN action (signs a message with the stored key).
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_SIGN = bytes32("SIGN");

    /// @notice Operation type for Sigmax trading-signal actions.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_SIGNAL = bytes32("SIGNAL");

    /// @notice Command for the EXECUTE action (decrypt a signal in the TEE and build swap auths).
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_EXECUTE = bytes32("EXECUTE");

    /// @notice Reference to the TEE extension registry contract.
    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;
    /// @notice Reference to the TEE machine registry contract.
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;

    /// @notice First public extension ID. The registry reserves IDs below this
    /// for system/reserved extensions; public extensions are assigned from here up.
    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000; // 65536

    uint256 private _extensionId;

    /// @notice strategyId => number of signals published (commit-before-outcome ledger).
    mapping(address => uint256) public signalCount;
    /// @notice strategyId => index => keccak256 of the encrypted signal (the commitment).
    mapping(address => mapping(uint256 => bytes32)) public commitOf;

    /// @notice Canonical publish record: the ciphertext commitment is on-chain BEFORE the
    ///         signal's outcome is known, making the leader's track record auditable without
    ///         ever revealing the strategy (the plaintext never touches the chain).
    event SignalPublished(
        address indexed leader,
        address indexed strategyId,
        uint256 indexed index,
        bytes32 ciphertextHash,
        string uri,
        uint256 timestamp
    );

    /// @notice Initializes the contract with registry addresses.
    /// @param _teeExtensionRegistry Address of the TEE extension registry.
    /// @param _teeMachineRegistry Address of the TEE machine registry.
    constructor(
        ITeeExtensionRegistry _teeExtensionRegistry,
        ITeeMachineRegistry _teeMachineRegistry
    ) {
        require(address(_teeExtensionRegistry) != address(0), "TeeExtensionRegistry cannot be zero address");
        require(address(_teeMachineRegistry) != address(0), "TeeMachineRegistry cannot be zero address");
        require(address(_teeExtensionRegistry).code.length > 0, "TeeExtensionRegistry has no code");
        require(address(_teeMachineRegistry).code.length > 0, "TeeMachineRegistry has no code");
        TEE_EXTENSION_REGISTRY = _teeExtensionRegistry;
        TEE_MACHINE_REGISTRY = _teeMachineRegistry;
    }

    /// @notice Finds and sets this contract's extension id. Can only be set once.
    /// DO NOT MODIFY this function.
    function setExtensionId() external {
        require(_extensionId == 0, "Extension ID already set.");

        uint256 c = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < c; ++i) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(i) == address(this)) {
                _extensionId = i;
                return;
            }
        }
        revert("Extension ID not found.");
    }

    /// @notice Update the stored private key by sending an encrypted key payload to the TEE.
    /// @param _encryptedKey ECIES-encrypted (or otherwise sealed) private-key bytes that the
    ///        TEE node will decrypt before storing the inner secp256k1 private key.
    function updateKey(bytes calldata _encryptedKey) external payable {
        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        address[] memory cosigners = new address[](0);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_KEY,
            opCommand: OP_COMMAND_UPDATE,
            message: _encryptedKey,
            cosigners: cosigners,
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(
            teeIds,
            params
        );
    }

    /// @notice Request the TEE to sign a message with the stored private key.
    /// @param _message Raw bytes to sign. The TEE returns the signature in the action result.
    function sign(bytes calldata _message) external payable {
        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        address[] memory cosigners = new address[](0);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_KEY,
            opCommand: OP_COMMAND_SIGN,
            message: _message,
            cosigners: cosigners,
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(
            teeIds,
            params
        );
    }

    /// @notice Publish an encrypted Sigmax signal: record its commitment, then route the
    ///         ciphertext to the TEE as a SIGNAL/EXECUTE instruction. The ECIES-encrypted
    ///         signal is decrypted only inside the enclave; on-chain there is only the
    ///         ciphertext + its keccak256 commitment.
    /// @param _strategyId The strategy identifier followers subscribe to.
    /// @param _uri        Optional off-chain pointer to the ciphertext (may be empty).
    /// @param _ciphertext ECIES ciphertext of the ABI-encoded signal (encrypted to the enclave key).
    /// @return index The monotonic index of this signal for the strategy.
    function publishSignal(address _strategyId, string calldata _uri, bytes calldata _ciphertext)
        external
        payable
        returns (uint256 index)
    {
        require(_ciphertext.length > 0, "ciphertext must not be empty");

        bytes32 ciphertextHash = keccak256(_ciphertext);
        index = signalCount[_strategyId]++;
        commitOf[_strategyId][index] = ciphertextHash;
        emit SignalPublished(msg.sender, _strategyId, index, ciphertextHash, _uri, block.timestamp);

        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        address[] memory cosigners = new address[](0);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_SIGNAL,
            opCommand: OP_COMMAND_EXECUTE,
            message: _ciphertext,
            cosigners: cosigners,
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(
            teeIds,
            params
        );
    }

    /// @notice Returns the cached extension ID, reverting if not yet set.
    /// @return The extension ID assigned to this contract.
    function _getExtensionId() internal view returns (uint256) {
        require(_extensionId != 0, "Extension ID is not set.");
        return _extensionId;
    }
}
