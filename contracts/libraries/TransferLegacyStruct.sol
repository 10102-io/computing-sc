// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

library TransferLegacyStruct {
  struct LegacyExtraConfig {
    uint256 lackOfOutgoingTxRange;
    uint256 delayLayer2;
    uint256 delayLayer3;
  }

  struct Distribution {
    address user;
    uint256 percent;
  }

  struct Swap {
    address router;
    address weth;
  }

  struct EOALegacyETHSwap {
    address storageToken;
    uint256 amountOutMin;
    uint256 deadline;
  }
}
