/** Extension configuration constants. */

export const VERSION = "0.1.0";

/** OPType and OPCommand constants — must match the bytes32 constants in InstructionSender.sol. */
export const OP_TYPE_KEY = "KEY";
export const OP_COMMAND_UPDATE = "UPDATE";
export const OP_COMMAND_SIGN = "SIGN";

/** Sigmax confidential copy-trading: decrypt a signal in the enclave and issue swap authorizations. */
export const OP_TYPE_SIGNAL = "SIGNAL";
export const OP_COMMAND_EXECUTE = "EXECUTE";
