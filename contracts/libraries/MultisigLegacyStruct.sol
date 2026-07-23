// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

library MultisigLegacyStruct {
  struct LegacyExtraConfig {
    uint128 minRequiredSignatures;
    uint128 lackOfOutgoingTxRange;
  }
}
