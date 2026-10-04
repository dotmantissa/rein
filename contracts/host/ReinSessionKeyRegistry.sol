// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ReinSessionKeyRegistry
/// @notice The host-chain half of REIN.
///
/// REIN's claim is that a semantic verdict on GenLayer takes spending authority
/// away from an agent on the chain where the money actually is. That only means
/// something if the authority lives somewhere that can be switched off. This
/// contract is that somewhere.
///
/// A delegator opens a delegation, escrows the allowance, and names a session
/// key. The agent spends by calling `spend` with that key, and every spend
/// checks the delegation is still live. The guardian -- the REIN Enforcer's
/// relayer, and the only account that can do this -- flips a revoked
/// delegation's state, at which point the session key stops working. It cannot
/// move funds, redirect them, or raise the ceiling: revoke and restore are the
/// whole of its power.
///
/// Every state change emits an event. The Enforcer reads those receipts back
/// over JSON-RPC and will not mark a delegation revoked on GenLayer until it has
/// seen the revocation land here.
contract ReinSessionKeyRegistry {
    enum State {
        NONE,
        ACTIVE,
        REVOKED
    }

    struct Delegation {
        address delegator;
        address agent;
        address sessionKey;
        uint256 ceilingWei;
        uint256 spentWei;
        uint256 escrowWei;
        State state;
        bytes32 verdictRef;
        bytes32 appealRef;
        uint64 openedAt;
        uint64 changedAt;
    }

    address public admin;

    /// @notice The REIN Enforcer relayer. May revoke and restore, nothing else.
    address public guardian;

    mapping(bytes32 => Delegation) private _delegations;
    bytes32[] private _ids;

    event DelegationOpened(
        bytes32 indexed delegationId,
        address indexed delegator,
        address indexed agent,
        address sessionKey,
        uint256 ceilingWei
    );
    event DelegationFunded(bytes32 indexed delegationId, uint256 amount, uint256 escrowWei);
    event Spent(bytes32 indexed delegationId, address indexed to, uint256 amount, uint256 spentWei);
    event SpendRejected(bytes32 indexed delegationId, address indexed to, uint256 amount, string reason);
    event DelegationRevoked(bytes32 indexed delegationId, bytes32 verdictRef, address guardian);
    event DelegationRestored(bytes32 indexed delegationId, bytes32 appealRef, address guardian);
    event EscrowWithdrawn(bytes32 indexed delegationId, address indexed to, uint256 amount);
    event GuardianChanged(address indexed previous, address indexed next);
    event AdminChanged(address indexed previous, address indexed next);

    error NotAdmin();
    error NotGuardian();
    error NotSessionKey();
    error NotDelegator();
    error UnknownDelegation();
    error DelegationExists();
    error NotActive();
    error NotRevoked();
    error ZeroAddress();
    error ZeroId();
    error CeilingExceeded(uint256 ceilingWei, uint256 attemptedTotal);
    error EscrowExhausted(uint256 escrowWei, uint256 attempted);
    error CallFailed();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    constructor(address initialGuardian) {
        if (initialGuardian == address(0)) revert ZeroAddress();
        admin = msg.sender;
        guardian = initialGuardian;
        emit AdminChanged(address(0), msg.sender);
        emit GuardianChanged(address(0), initialGuardian);
    }

    // ---------------------------------------------------------------- lifecycle

    /// @notice Open a delegation and escrow its allowance in one call.
    /// @param delegationId keccak256 of the GenLayer delegation_id string. Use
    ///        `delegationIdOf` to derive it, so the two chains always agree on
    ///        which delegation is being talked about.
    function openDelegation(
        bytes32 delegationId,
        address agent,
        address sessionKey,
        uint256 ceilingWei
    ) external payable {
        if (delegationId == bytes32(0)) revert ZeroId();
        if (agent == address(0) || sessionKey == address(0)) revert ZeroAddress();
        if (_delegations[delegationId].state != State.NONE) revert DelegationExists();

        _delegations[delegationId] = Delegation({
            delegator: msg.sender,
            agent: agent,
            sessionKey: sessionKey,
            ceilingWei: ceilingWei,
            spentWei: 0,
            escrowWei: msg.value,
            state: State.ACTIVE,
            verdictRef: bytes32(0),
            appealRef: bytes32(0),
            openedAt: uint64(block.timestamp),
            changedAt: uint64(block.timestamp)
        });
        _ids.push(delegationId);

        emit DelegationOpened(delegationId, msg.sender, agent, sessionKey, ceilingWei);
        if (msg.value > 0) {
            emit DelegationFunded(delegationId, msg.value, msg.value);
        }
    }

    /// @notice Add to a delegation's escrowed allowance.
    function fund(bytes32 delegationId) external payable {
        Delegation storage d = _delegations[delegationId];
        if (d.state == State.NONE) revert UnknownDelegation();
        d.escrowWei += msg.value;
        emit DelegationFunded(delegationId, msg.value, d.escrowWei);
    }

    /// @notice Spend from a delegation. Only the session key may call this, and
    /// only while the delegation is live.
    ///
    /// This is where a REIN revocation bites: after `revoke`, every call here
    /// reverts, so the agent's key is inert even though it is still a valid
    /// key. The deterministic ceiling is enforced here too -- REIN is the
    /// semantic layer on top of it, not a replacement for it.
    function spend(
        bytes32 delegationId,
        address to,
        uint256 amount,
        bytes calldata data
    ) external returns (bytes memory) {
        Delegation storage d = _delegations[delegationId];
        if (d.state == State.NONE) revert UnknownDelegation();
        if (msg.sender != d.sessionKey) revert NotSessionKey();
        if (d.state != State.ACTIVE) {
            emit SpendRejected(delegationId, to, amount, "delegation revoked by REIN");
            revert NotActive();
        }
        if (to == address(0)) revert ZeroAddress();

        uint256 nextSpent = d.spentWei + amount;
        if (nextSpent > d.ceilingWei) revert CeilingExceeded(d.ceilingWei, nextSpent);
        if (amount > d.escrowWei) revert EscrowExhausted(d.escrowWei, amount);

        d.spentWei = nextSpent;
        d.escrowWei -= amount;

        (bool ok, bytes memory ret) = to.call{value: amount}(data);
        if (!ok) revert CallFailed();

        emit Spent(delegationId, to, amount, nextSpent);
        return ret;
    }

    /// @notice Return unspent escrow to the delegator. Available at any time:
    /// REIN governs what the agent may do with the allowance, not whether the
    /// delegator may take their own money back.
    function withdrawUnspent(bytes32 delegationId, uint256 amount) external {
        Delegation storage d = _delegations[delegationId];
        if (d.state == State.NONE) revert UnknownDelegation();
        if (msg.sender != d.delegator) revert NotDelegator();
        if (amount > d.escrowWei) revert EscrowExhausted(d.escrowWei, amount);

        d.escrowWei -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert CallFailed();
        emit EscrowWithdrawn(delegationId, msg.sender, amount);
    }

    // --------------------------------------------------------------- enforcement

    /// @notice Revoke a delegation on behalf of a GenLayer breach verdict.
    /// @param verdictRef keccak256 of the ReinCourt verdict_id that justifies it,
    ///        so the on-chain record points back at the ruling.
    function revoke(bytes32 delegationId, bytes32 verdictRef) external onlyGuardian {
        Delegation storage d = _delegations[delegationId];
        if (d.state == State.NONE) revert UnknownDelegation();
        if (d.state != State.ACTIVE) revert NotActive();

        d.state = State.REVOKED;
        d.verdictRef = verdictRef;
        d.changedAt = uint64(block.timestamp);

        emit DelegationRevoked(delegationId, verdictRef, msg.sender);
    }

    /// @notice Restore a delegation after an overturned appeal.
    /// @param appealRef keccak256 of the Enforcer appeal_id that overturned it.
    function restore(bytes32 delegationId, bytes32 appealRef) external onlyGuardian {
        Delegation storage d = _delegations[delegationId];
        if (d.state == State.NONE) revert UnknownDelegation();
        if (d.state != State.REVOKED) revert NotRevoked();

        d.state = State.ACTIVE;
        d.appealRef = appealRef;
        d.changedAt = uint64(block.timestamp);

        emit DelegationRestored(delegationId, appealRef, msg.sender);
    }

    function setGuardian(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        emit GuardianChanged(guardian, next);
        guardian = next;
    }

    function setAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        emit AdminChanged(admin, next);
        admin = next;
    }

    // --------------------------------------------------------------------- views

    /// @notice True while the session key can still spend. This is the single
    /// boolean the Enforcer checks before it will record a delegation as
    /// revoked on GenLayer.
    function isActive(bytes32 delegationId) external view returns (bool) {
        return _delegations[delegationId].state == State.ACTIVE;
    }

    function stateOf(bytes32 delegationId) external view returns (State) {
        return _delegations[delegationId].state;
    }

    function getDelegation(bytes32 delegationId) external view returns (Delegation memory) {
        Delegation memory d = _delegations[delegationId];
        if (d.state == State.NONE) revert UnknownDelegation();
        return d;
    }

    function remainingAllowance(bytes32 delegationId) external view returns (uint256) {
        Delegation memory d = _delegations[delegationId];
        if (d.state != State.ACTIVE) return 0;
        uint256 headroom = d.ceilingWei > d.spentWei ? d.ceilingWei - d.spentWei : 0;
        return headroom < d.escrowWei ? headroom : d.escrowWei;
    }

    function delegationCount() external view returns (uint256) {
        return _ids.length;
    }

    function delegationIdAt(uint256 index) external view returns (bytes32) {
        return _ids[index];
    }

    /// @notice Derive the host-chain handle for a GenLayer delegation_id string.
    /// Both halves of REIN compute this the same way, so neither side has to be
    /// told which delegation the other means.
    function delegationIdOf(string calldata genlayerDelegationId) external pure returns (bytes32) {
        return keccak256(bytes(genlayerDelegationId));
    }
}
