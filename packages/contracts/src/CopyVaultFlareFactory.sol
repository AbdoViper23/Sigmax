// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CopyVaultFlare} from "./CopyVaultFlare.sol";

/// @title CopyVaultFlareFactory
/// @notice Deploys one deterministic (CREATE2) CopyVaultFlare per follower. Each follower gets a vault
///         they own; the factory only supplies the TEE verifier + the currently attested TEE address.
contract CopyVaultFlareFactory {
    using SafeERC20 for IERC20;

    address public immutable teeVerifier;

    /// @notice The TEE identity stamped into newly created vaults.
    ///
    /// @dev NOT immutable, and the reason matters. An enclave that re-attests gets a new signing
    ///      identity, and with an immutable value here the only way to follow it was to redeploy the
    ///      factory — which moves `vaultOf` to a fresh contract and strands every existing follower's
    ///      vault (and its funds) behind an address the app no longer reads. Losing track of user
    ///      funds to work around a config change is not an acceptable trade.
    ///
    ///      TRUST BOUNDARY, stated plainly: `admin` can change which TEE identity *future* vaults
    ///      trust. It cannot touch an existing vault — each one stores its own `teeAddress` from
    ///      construction and only its owner may call `setTeeAddress`. So this widens the admin's reach
    ///      from deploy-time to any time for NEW vaults, and not at all for existing ones. Every
    ///      change is evented so a follower can verify what their vault was created against before
    ///      funding it.
    address public teeAddress;

    /// @notice Can rotate `teeAddress`. Set to address(0) to make the current value permanent.
    address public admin;

    /// @notice follower => their vault (address(0) if none yet).
    mapping(address => address) public vaultOf;

    event VaultCreated(address indexed owner, address vault);
    event VaultFunded(address indexed owner, address indexed vault, address indexed token, uint256 amount);
    event TeeAddressUpdated(address indexed previous, address indexed current);
    event AdminTransferred(address indexed previous, address indexed current);

    error VaultExists();
    error TokenNotWhitelisted();
    error NothingToDeposit();
    error NotAdmin();
    error ZeroTeeAddress();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address _teeVerifier, address _teeAddress, address _admin) {
        teeVerifier = _teeVerifier;
        teeAddress = _teeAddress;
        admin = _admin;
        emit TeeAddressUpdated(address(0), _teeAddress);
        emit AdminTransferred(address(0), _admin);
    }

    /// @notice Point newly created vaults at a re-attested enclave identity.
    /// @dev Existing vaults are untouched; their owners repoint their own via `CopyVaultFlare.setTeeAddress`.
    function setTeeAddress(address _teeAddress) external onlyAdmin {
        if (_teeAddress == address(0)) revert ZeroTeeAddress();
        emit TeeAddressUpdated(teeAddress, _teeAddress);
        teeAddress = _teeAddress;
    }

    /// @notice Hand over or renounce admin. Passing address(0) freezes `teeAddress` forever.
    /// @dev The renounce path is the point: once the enclave identity is stable (real attestation, not
    ///      a simulated TEE that re-keys on restart), the rotation power should be given up rather
    ///      than left lying around.
    function transferAdmin(address _admin) external onlyAdmin {
        emit AdminTransferred(admin, _admin);
        admin = _admin;
    }

    /// @notice Create the caller's non-custodial vault (one per address). Reverts if it already exists.
    function createVault(address[] calldata tokens, address[] calldata routers, uint256 cap)
        public
        returns (address vault)
    {
        if (vaultOf[msg.sender] != address(0)) revert VaultExists();
        vault = address(
            new CopyVaultFlare{salt: _salt(msg.sender)}(msg.sender, teeVerifier, teeAddress, tokens, routers, cap)
        );
        vaultOf[msg.sender] = vault;
        emit VaultCreated(msg.sender, vault);
    }

    /// @notice Create the caller's vault and fund it in the same transaction.
    /// @dev Onboarding is the point: `createVault` then `deposit` costs the follower two signatures
    ///      and surfaces "create a vault" as a step they have to understand before they can do the
    ///      thing they came to do. Here they approve this factory once and fund in a single action.
    ///
    ///      The tokens move straight from the caller to the new vault — the factory never holds a
    ///      balance, so there is nothing here to drain and no approval left sitting on it afterwards
    ///      beyond what the caller granted. The whitelist is re-checked against the *vault* rather
    ///      than trusted from `tokens`, so a token that failed to register cannot be funded into a
    ///      vault that would then refuse to trade it.
    /// @param token The token to fund. Must be whitelisted on the freshly created vault.
    /// @param amount Amount to pull from the caller. Must be non-zero.
    function createVaultAndDeposit(
        address[] calldata tokens,
        address[] calldata routers,
        uint256 cap,
        address token,
        uint256 amount
    ) external returns (address vault) {
        if (amount == 0) revert NothingToDeposit();
        vault = createVault(tokens, routers, cap);
        if (!CopyVaultFlare(vault).tokenWhitelisted(token)) revert TokenNotWhitelisted();
        IERC20(token).safeTransferFrom(msg.sender, vault, amount);
        emit VaultFunded(msg.sender, vault, token, amount);
    }

    /// @notice Predict the deterministic vault address for `ownerAddr` given the same creation args.
    function predictVault(address ownerAddr, address[] calldata tokens, address[] calldata routers, uint256 cap)
        external
        view
        returns (address)
    {
        bytes memory initCode = abi.encodePacked(
            type(CopyVaultFlare).creationCode, abi.encode(ownerAddr, teeVerifier, teeAddress, tokens, routers, cap)
        );
        bytes32 hash = keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(ownerAddr), keccak256(initCode)));
        return address(uint160(uint256(hash)));
    }

    function _salt(address ownerAddr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(ownerAddr)));
    }
}
