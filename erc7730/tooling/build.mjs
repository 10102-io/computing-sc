// Generates the 10102 ERC-7730 descriptors and their testsv2 fixtures.
// Format keys are derived from the Sourcify ABIs (abis/*.json), so every
// selector matches the deployed implementation. Expected renderings come
// from expected/<descriptor>.json once reviewed; until then a case expects
// nothing and the runner output is used for review.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  encodeFunctionData,
  getAddress,
  maxUint160,
  maxUint256,
  parseEther,
  parseUnits,
  serializeTransaction,
  toFunctionSelector
} from 'viem';

const ENTITY = '10102';
const OUT = `out/registry/${ENTITY}`;
const OWNER = '10102';
const INFO = { url: 'https://10102.io' };

const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0';
const PULL_VAULT = '0x95F0981026C7e804fD6ba8bE738cA7c380C7f978';
const ALICE = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const BOB = '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B';
const CAROL = '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db';
const DAVE = '0x78731D3Ca6b7E34aC0F824c42a7cC18A495cabaB';
const DAY = 86_400n;
const NO_VETO = maxUint256;

const dataProvider = {
  tokens: {
    [USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6, name: 'USD Coin' },
    [WETH.toLowerCase()]: { symbol: 'WETH', decimals: 18, name: 'Wrapped Ether' },
    [WSTETH.toLowerCase()]: { symbol: 'wstETH', decimals: 18, name: 'Wrapped liquid staked Ether 2.0' }
  },
  addressNames: { [PULL_VAULT.toLowerCase()]: '10102 LegacyPullVault' }
};

// Ledger screen limits; the build fails instead of shipping a truncated line.
const MAX_LABEL = 20;
const MAX_INTENT = 30;

// ── field helpers ────────────────────────────────────────────────────────
// Beneficiaries and recipients may be contracts (a Safe), and are not the
// signer's own accounts, so person fields carry no address `types`.
const person = (path, label) => ({ path, label, format: 'addressName', params: { sources: ['local', 'ens'] } });
const tokenAddr = (path, label) => ({ path, label, format: 'addressName', params: { types: ['token'], sources: ['local'] } });
const contractAddr = (path, label) => ({ path, label, format: 'addressName', params: { types: ['contract'], sources: ['local'] } });
const collectionAddr = (path, label) => ({ path, label, format: 'addressName', params: { types: ['collection'], sources: ['local'] } });
const bundled = (...fields) => ({ iteration: 'bundled', fields });
const never = (path, label) => ({ path, label, visible: 'never' });
const dur = (path, label) => ({ path, label, format: 'duration' });
const pct1e6 = (path, label) => ({ path, label, format: 'unit', params: { base: '%', decimals: 4 } });
const pctBps = (path, label) => ({ path, label, format: 'unit', params: { base: '%', decimals: 2 } });
const eth = (path, label) => ({ path, label, format: 'amount' });
const tokAmt = (path, label, tokenPath, extra = {}) => ({ path, label, format: 'tokenAmount', params: { tokenPath, ...extra } });
const date = (path, label) => ({ path, label, format: 'date', params: { encoding: 'timestamp' } });
const raw = (path, label) => ({ path, label, format: 'raw' });
const unlessZero = (field, zero = 0) => ({ ...field, visible: { ifNotIn: [zero] } });
const unlessNoAddress = (field) => unlessZero(field, ZERO);

const hex = (n) => `0x${n.toString(16)}`;

// ── descriptor specs ─────────────────────────────────────────────────────
const legacyId = raw('legacyId_', 'Legacy');
const beneficiaries = (base) => [
  bundled(person(`${base}.[].user`, 'Beneficiary'), pct1e6(`${base}.[].percent`, 'Share')),
  never(`${base}.[]`, 'Beneficiaries')
];
// The legacy treats a backup's percent as a switch: 0 removes the backup even
// when an address is given, any other value stores 100% of its layer. So it
// is always shown, and a value other than the two the app sends renders raw.
const backupShare = (path, label) => ({ path, label, format: 'enum', params: { $ref: '$.metadata.enums.backupShare' } });
const shieldBeneficiaries = bundled(person('config.beneficiaries.[]', 'Beneficiary'), pctBps('config.sharesBps.[]', 'Share'));

const SPECS = [
  {
    name: 'TransferEOALegacyRouter',
    abiFile: 'abis/TransferEOALegacyRouter.json',
    deployments: [{ chainId: 1, address: '0x4E81E1Ed3F6684EB948F8956b8787967b1a6275b' }],
    paramNames: {
      'setLayer23Distributions(uint256,uint8,string,(address,uint256))': ['legacyId_', 'layer_', 'nickname_', 'distribution_'],
      'setBothLayer23Distributions(uint256,string,(address,uint256),string,(address,uint256))': ['legacyId_', 'layer2Nickname_', 'layer2Distribution_', 'layer3Nickname_', 'layer3Distribution_'],
      'setLegacyConfig(uint256,(string,string,string[],(address,uint256)[]),(uint256,uint256,uint256),(address,uint256),(address,uint256),string,string)': ['legacyId_', 'mainConfig_', 'extraConfig_', 'layer2Distribution_', 'layer3Distribution_', 'layer2Nickname_', 'layer3Nickname_']
    },
    enums: { layer: { 2: 'First backup', 3: 'Second backup' }, backupShare: { 0: 'None', 1000000: '100%' } },
    formats: {
      createLegacyV2: {
        intent: 'Create legacy, approve tokens',
        fields: [
          ...beneficiaries('distributions_'),
          dur('extraConfig_.lackOfOutgoingTxRange', 'Inactivity period'),
          unlessNoAddress(person('layer2Distribution_.user', 'Backup beneficiary')),
          backupShare('layer2Distribution_.percent', 'Backup share'),
          unlessZero(dur('extraConfig_.delayLayer2', 'Backup delay')),
          unlessNoAddress(person('layer3Distribution_.user', 'Second backup')),
          backupShare('layer3Distribution_.percent', 'Second backup share'),
          unlessZero(dur('extraConfig_.delayLayer3', 'Second backup delay')),
          bundled(
            tokenAddr('permit2_.permitBatch.details.[].token', 'Token covered'),
            tokAmt('permit2_.permitBatch.details.[].amount', 'Amount covered', 'permit2_.permitBatch.details.[].token', { threshold: hex(maxUint160), message: 'Unlimited' }),
            date('permit2_.permitBatch.details.[].expiration', 'Permission expires')
          ),
          contractAddr('permit2_.permitBatch.spender', 'Permission held by'),
          never('permit2_.permitBatch.details.[].nonce', 'Permit nonce'),
          never('permit2_.permitBatch.details.[]', 'Permit details'),
          never('permit2_.permitBatch.sigDeadline', 'Permit deadline'),
          never('permit2_.signature', 'Permit signature'),
          never('signatureTimestamp', 'Terms timestamp'),
          never('agreementSignature', 'Terms signature')
        ],
        tests: [
          {
            description: 'Create a legacy for two beneficiaries with a backup, covering USDC and WETH',
            args: [
              [{ user: ALICE, percent: 600000n }, { user: BOB, percent: 400000n }],
              { lackOfOutgoingTxRange: 180n * DAY, delayLayer2: 90n * DAY, delayLayer3: 0n },
              { user: CAROL, percent: 1000000n },
              { user: ZERO, percent: 0n },
              {
                permitBatch: {
                  details: [
                    { token: USDC, amount: maxUint160, expiration: 1924991999, nonce: 0 },
                    { token: WETH, amount: parseEther('2'), expiration: 1924991999, nonce: 3 }
                  ],
                  spender: PULL_VAULT,
                  sigDeadline: 1800000000n
                },
                signature: '0x' + 'ab'.repeat(65)
              },
              1799990000n,
              '0x' + 'cd'.repeat(65)
            ]
          },
          {
            description: 'Create a legacy with two backups, covering wstETH',
            args: [
              [{ user: ALICE, percent: 1000000n }],
              { lackOfOutgoingTxRange: 365n * DAY, delayLayer2: 60n * DAY, delayLayer3: 30n * DAY },
              { user: CAROL, percent: 1000000n },
              { user: DAVE, percent: 1000000n },
              {
                permitBatch: {
                  details: [{ token: WSTETH, amount: parseEther('5'), expiration: 1924991999, nonce: 0 }],
                  spender: PULL_VAULT,
                  sigDeadline: 1800000000n
                },
                signature: '0x' + 'ab'.repeat(65)
              },
              0n,
              '0x'
            ]
          },
          {
            description: 'Create a legacy that names a backup with no share',
            args: [
              [{ user: ALICE, percent: 1000000n }],
              { lackOfOutgoingTxRange: 180n * DAY, delayLayer2: 0n, delayLayer3: 0n },
              { user: CAROL, percent: 0n },
              { user: ZERO, percent: 0n },
              {
                permitBatch: {
                  details: [{ token: USDC, amount: parseUnits('1000', 6), expiration: 1924991999, nonce: 1 }],
                  spender: PULL_VAULT,
                  sigDeadline: 1800000000n
                },
                signature: '0x' + 'ab'.repeat(65)
              },
              0n,
              '0x'
            ]
          }
        ]
      },
      avtiveAlive: {
        intent: 'Check in',
        interpolatedIntent: 'Check in on legacy {legacyId_}',
        fields: [legacyId],
        tests: [{ description: 'Check in on legacy 12', args: [12n] }]
      },
      setActivationTrigger: {
        intent: 'Change inactivity period',
        fields: [legacyId, dur('lackOfOutgoingTxRange_', 'Inactivity period')],
        tests: [{ description: 'Set legacy 12 to one year of inactivity', args: [12n, 365n * DAY] }]
      },
      setLegacyDistributions: {
        intent: 'Change beneficiaries',
        fields: [legacyId, ...beneficiaries('distributions_'), never('nickNames_', 'Nicknames (ignored)')],
        tests: [
          {
            description: 'Split legacy 12 evenly between two beneficiaries',
            args: [12n, ['', ''], [{ user: ALICE, percent: 500000n }, { user: DAVE, percent: 500000n }]]
          }
        ]
      },
      setLayer23Distributions: {
        intent: 'Change backup beneficiary',
        fields: [
          legacyId,
          { path: 'layer_', label: 'Backup', format: 'enum', params: { $ref: '$.metadata.enums.layer' } },
          person('distribution_.user', 'Backup beneficiary'),
          backupShare('distribution_.percent', 'Backup share'),
          never('nickname_', 'Nickname (ignored)')
        ],
        tests: [
          { description: 'Set the first backup of legacy 12', args: [12n, 2, '', { user: CAROL, percent: 1000000n }] },
          { description: 'Set the second backup of legacy 12', args: [12n, 3, '', { user: DAVE, percent: 1000000n }] }
        ]
      },
      setBothLayer23Distributions: {
        intent: 'Change backup beneficiaries',
        fields: [
          legacyId,
          person('layer2Distribution_.user', 'Backup beneficiary'),
          backupShare('layer2Distribution_.percent', 'Backup share'),
          person('layer3Distribution_.user', 'Second backup'),
          backupShare('layer3Distribution_.percent', 'Second backup share'),
          never('layer2Nickname_', 'Nickname 2'),
          never('layer3Nickname_', 'Nickname 3')
        ],
        tests: [
          {
            description: 'Set both backups of legacy 12',
            args: [12n, '', { user: CAROL, percent: 1000000n }, '', { user: DAVE, percent: 1000000n }]
          }
        ]
      },
      setLegacyConfig: {
        intent: 'Update legacy',
        fields: [
          legacyId,
          ...beneficiaries('mainConfig_.distributions'),
          dur('extraConfig_.lackOfOutgoingTxRange', 'Inactivity period'),
          person('layer2Distribution_.user', 'Backup beneficiary'),
          backupShare('layer2Distribution_.percent', 'Backup share'),
          unlessZero(dur('extraConfig_.delayLayer2', 'Backup delay')),
          unlessNoAddress(person('layer3Distribution_.user', 'Second backup')),
          backupShare('layer3Distribution_.percent', 'Second backup share'),
          unlessZero(dur('extraConfig_.delayLayer3', 'Second backup delay')),
          never('mainConfig_.name', 'Name'),
          never('mainConfig_.note', 'Note'),
          never('mainConfig_.nickNames', 'Nicknames'),
          never('layer2Nickname_', 'Nickname 2'),
          never('layer3Nickname_', 'Nickname 3')
        ],
        tests: [
          {
            description: 'Update beneficiaries, period and backup of legacy 12',
            args: [
              12n,
              { name: '', note: '', nickNames: [''], distributions: [{ user: ALICE, percent: 1000000n }] },
              { lackOfOutgoingTxRange: 360n * DAY, delayLayer2: 30n * DAY, delayLayer3: 0n },
              { user: CAROL, percent: 1000000n },
              { user: ZERO, percent: 0n },
              '',
              ''
            ]
          },
          {
            description: 'Update legacy 12 with two beneficiaries and two backups',
            args: [
              12n,
              { name: '', note: '', nickNames: ['', ''], distributions: [{ user: ALICE, percent: 700000n }, { user: BOB, percent: 300000n }] },
              { lackOfOutgoingTxRange: 365n * DAY, delayLayer2: 60n * DAY, delayLayer3: 30n * DAY },
              { user: CAROL, percent: 1000000n },
              { user: DAVE, percent: 1000000n },
              '',
              ''
            ]
          }
        ]
      },
      setAutoRenew: {
        intent: 'Set automatic renewal',
        fields: [legacyId, raw('enabled_', 'Automatic renewal on')],
        tests: [{ description: 'Turn on automatic renewal for legacy 12', args: [12n, true] }]
      },
      setSponsoredClaimsEnabled: {
        intent: 'Set gas-free claims',
        fields: [legacyId, raw('enabled_', 'Gas-free claims')],
        tests: [{ description: 'Turn off gas-free claims for legacy 12', args: [12n, false] }]
      },
      autoSwap: {
        intent: 'Convert ETH to a token',
        fields: [
          eth('@.value', 'ETH to convert'),
          tokenAddr('swap_.storageToken', 'Token received'),
          tokAmt('swap_.amountOutMin', 'Swap min (not WETH)', 'swap_.storageToken'),
          date('swap_.deadline', 'Deadline'),
          legacyId
        ],
        tests: [
          {
            description: 'Convert 0.5 ETH to WETH for legacy 12',
            args: [12n, { storageToken: WETH, amountOutMin: parseEther('0.5'), deadline: 1800000000n }],
            value: parseEther('0.5')
          }
        ]
      },
      unswap: {
        intent: 'Convert back to ETH',
        fields: [
          legacyId,
          raw('amountIn_', 'Token (base units)'),
          eth('amountOutMin_', 'Minimum ETH received'),
          date('deadline_', 'Deadline')
        ],
        tests: [{ description: 'Convert 0.5 wstETH back to ETH for legacy 12', args: [12n, parseEther('0.5'), parseEther('0.59'), 1800000000n] }]
      },
      withdraw: {
        intent: 'Withdraw ETH from legacy',
        fields: [legacyId, eth('amount_', 'Amount')],
        tests: [{ description: 'Withdraw 0.1 ETH from legacy 12', args: [12n, parseEther('0.1')] }]
      },
      deleteLegacy: {
        intent: 'Delete legacy',
        interpolatedIntent: 'Delete legacy {legacyId_}',
        fields: [legacyId],
        tests: [{ description: 'Delete legacy 12', args: [12n] }]
      },
      activeLegacy: {
        intent: 'Claim legacy',
        fields: [legacyId, tokenAddr('assets_.[]', 'Token claimed'), raw('isETH_', 'Include ETH')],
        tests: [{ description: 'Claim USDC, WETH and ETH from legacy 12', args: [12n, [USDC, WETH], true] }]
      },
      activeLegacyAndUnswap: {
        intent: 'Claim legacy as ETH',
        fields: [
          legacyId,
          tokenAddr('assets_.[]', 'Token claimed'),
          eth('amountOutMin_', 'Swap min (not WETH)'),
          date('deadline_', 'Deadline')
        ],
        tests: [{ description: 'Claim legacy 12 and convert its WETH to ETH', args: [12n, [WETH], parseEther('0.99'), 1800000000n] }]
      }
    }
  },
  {
    name: 'TimeLockRouter',
    abiFile: 'abis/TimeLockRouter.json',
    deployments: [{ chainId: 1, address: '0x2B947E3c348c81409f8e8fc5ef8F65d9dFf76A42' }],
    formats: {
      createTimelock: timelockCreate('timelockRegular', 'Create timelock', 'duration', 'Locked for'),
      createSoftTimelock: timelockCreate('timelockSoft', 'Create soft timelock', 'bufferTime', 'Unlock delay'),
      createTimelockedGift: timelockCreate('timelockGift', 'Seal gift and accept terms', 'duration', 'Opens after', 'Seal gift'),
      unlockSoftTimelock: {
        intent: 'Start soft timelock countdown',
        fields: [raw('id', 'Timelock')],
        tests: [{ description: 'Start the countdown on timelock 7', args: [7n] }]
      },
      'withdraw(uint256)': {
        intent: 'Withdraw from timelock',
        fields: [raw('id', 'Timelock')],
        tests: [{ description: 'Withdraw timelock 7', args: [7n] }]
      },
      'withdraw(uint256,bool)': {
        intent: 'Withdraw from timelock',
        fields: [raw('id', 'Timelock'), raw('skipSwap', 'Skip ETH conversion')],
        tests: [
          { description: 'Withdraw timelock 7 and keep the token', args: [7n, true] },
          { description: 'Withdraw timelock 7 converted back to ETH', args: [7n, false] }
        ]
      }
    }
  },
  {
    name: 'ShieldVault',
    abiFile: 'abis/ShieldVault.json',
    deployments: [{ chainId: 1, address: '0xA1EA2F8C0518458975E09ED63bf5D48980f76C38' }],
    formats: {
      open: {
        intent: 'Open Shield Vault holding',
        fields: [
          tokAmt('amount', 'Amount', 'token'),
          dur('config.exitDelay', 'Withdrawals wait'),
          dur('config.silencePeriod', 'Silence (0=off)'),
          shieldBeneficiaries,
          pctBps('maxFeeBps', 'Maximum exit fee'),
          raw('vetoIndex', 'Recovery (max=off)'),
          never('token', 'Token'),
          never('config.holdMask', 'Held shares')
        ],
        tests: [
          {
            description: 'Open a 10 wstETH holding for two beneficiaries',
            args: [WSTETH, parseEther('10'), { exitDelay: 7 * 86400, silencePeriod: 365 * 86400, beneficiaries: [ALICE, BOB], sharesBps: [7000, 3000], holdMask: 2 }, 0n, 25]
          },
          {
            description: 'Open a 5 wstETH holding with no fallback and no recovery sheet',
            args: [WSTETH, parseEther('5'), { exitDelay: 30 * 86400, silencePeriod: 0, beneficiaries: [], sharesBps: [], holdMask: 0 }, NO_VETO, 25]
          }
        ]
      },
      deposit: {
        intent: 'Add to Shield Vault holding',
        fields: [raw('id', 'Holding'), raw('amount', 'Amount (base units)')],
        tests: [{ description: 'Add to holding 3', args: [3n, parseEther('1')] }]
      },
      checkIn: {
        intent: 'Check in',
        interpolatedIntent: 'Check in on holding {id}',
        fields: [raw('id', 'Holding')],
        tests: [{ description: 'Check in on holding 3', args: [3n] }]
      },
      requestWithdraw: {
        intent: 'Request withdrawal (exit fee)',
        fields: [
          raw('id', 'Holding'),
          raw('amount', 'Before fee (max=all)'),
          person('to', 'To')
        ],
        tests: [
          { description: 'Request a withdrawal of everything from holding 3', args: [3n, maxUint256, DAVE] },
          { description: 'Request a partial withdrawal from holding 3', args: [3n, parseEther('2'), DAVE] }
        ]
      },
      cancelPending: {
        intent: 'Cancel pending request',
        fields: [raw('id', 'Holding')],
        tests: [{ description: 'Cancel the pending request on holding 3', args: [3n] }]
      },
      executePending: {
        intent: 'Complete request (fee on exit)',
        fields: [raw('id', 'Holding')],
        tests: [{ description: 'Complete the pending request on holding 3', args: [3n] }]
      },
      executeFallback: {
        intent: 'Release to beneficiaries (fee)',
        fields: [raw('id', 'Holding')],
        tests: [{ description: 'Release holding 3 to its beneficiaries', args: [3n] }]
      },
      requestChange: {
        intent: 'Request settings change',
        fields: [
          raw('id', 'Holding'),
          dur('config.exitDelay', 'Withdrawals wait'),
          dur('config.silencePeriod', 'Silence (0=off)'),
          shieldBeneficiaries,
          raw('vetoIndex', 'Recovery (max=off)'),
          never('config.holdMask', 'Held shares')
        ],
        tests: [
          {
            description: 'Change holding 3 to one beneficiary',
            args: [3n, { exitDelay: 30 * 86400, silencePeriod: 730 * 86400, beneficiaries: [CAROL], sharesBps: [10000], holdMask: 0 }, 1n]
          },
          {
            description: 'Split holding 3 in two and remove its recovery sheet',
            args: [3n, { exitDelay: 7 * 86400, silencePeriod: 365 * 86400, beneficiaries: [ALICE, BOB], sharesBps: [5000, 5000], holdMask: 0 }, NO_VETO]
          }
        ]
      },
      veto: {
        intent: 'Send all to recovery wallet',
        fields: [raw('id', 'Holding'), person('recoveryTo', 'Recovery wallet'), never('secret', 'Recovery secret')],
        tests: [{ description: 'Stop holding 3 and move it to the recovery wallet', args: [3n, '0x' + '11'.repeat(32), CAROL] }]
      },
      claimOwed: {
        intent: 'Claim held share',
        fields: [raw('id', 'Holding'), person('beneficiary', 'Paid to')],
        tests: [{ description: 'Pay the held share of holding 3', args: [3n, BOB] }]
      }
    }
  }
];

function timelockCreate(arg, intent, durationField, durationLabel, subject = intent) {
  const b = arg;
  const isGift = arg === 'timelockGift';
  const fields = [
    unlessZero(eth('@.value', 'ETH sent to lock')),
    unlessNoAddress(tokenAddr(`${b}.timelockETHSwap.storageToken`, 'ETH held as')),
    unlessZero(tokAmt(`${b}.timelockETHSwap.amountOutMin`, 'Swap min (not WETH)', `${b}.timelockETHSwap.storageToken`)),
    unlessZero(date(`${b}.timelockETHSwap.deadline`, 'Swap deadline')),
    tokAmt(`${b}.timelockERC20.[].amount`, 'Token sent to lock', `${b}.timelockERC20.[].tokenAddress`),
    bundled(
      collectionAddr(`${b}.timelockERC721.[].tokenAddress`, 'NFT collection'),
      { path: `${b}.timelockERC721.[].id`, label: 'NFT locked', format: 'nftName', params: { collectionPath: `${b}.timelockERC721.[].tokenAddress` } }
    ),
    bundled(
      collectionAddr(`${b}.timelockERC1155.[].tokenAddress`, 'Item collection'),
      { path: `${b}.timelockERC1155.[].id`, label: 'Item locked', format: 'nftName', params: { collectionPath: `${b}.timelockERC1155.[].tokenAddress` } },
      raw(`${b}.timelockERC1155.[].amount`, 'Item quantity')
    ),
    dur(`${b}.${durationField}`, durationLabel),
    ...(isGift ? [person(`${b}.recipient`, 'Recipient')] : []),
    never(`${b}.timelockERC20.[].tokenAddress`, 'Token address'),
    never(`${b}.timelockERC20.[]`, 'Tokens'),
    never(`${b}.timelockERC721.[]`, 'NFTs'),
    never(`${b}.timelockERC1155.[]`, 'Items'),
    never(`${b}.name`, 'Name'),
    ...(isGift ? [never(`${b}.giftName`, 'Gift name')] : [])
  ];
  const base = {
    timelockETHSwap: { storageToken: ZERO, amountOutMin: 0n, deadline: 0n },
    timelockERC20: [{ tokenAddress: USDC, amount: parseUnits('250', 6) }],
    timelockERC721: [],
    timelockERC1155: [],
    name: isGift ? 'Gift' : 'Savings Oct 2026'
  };
  const withEth = {
    ...base,
    timelockETHSwap: { storageToken: WETH, amountOutMin: parseEther('0.3'), deadline: 1800000000n },
    timelockERC20: []
  };
  // No NFT case: the app never locks NFTs, and the runners differ on
  // whether they resolve a collection's name (nftName allows either).
  const extra = (o) =>
    isGift
      ? { ...o, duration: 1825n * DAY, recipient: ALICE, giftName: '' }
      : { ...o, [durationField]: (durationField === 'bufferTime' ? 7n : 365n) * DAY };
  return {
    intent,
    fields,
    tests: [
      { description: `${subject} with 250 USDC`, args: [extra(base)] },
      { description: `${subject} with 0.3 ETH held as WETH`, args: [extra(withEth)], value: parseEther('0.3') }
    ]
  };
}

// ── ABI-driven keys ──────────────────────────────────────────────────────
const typeOf = (p) => (p.type.startsWith('tuple') ? `(${p.components.map(typeOf).join(',')})${p.type.slice(5)}` : p.type);
const named = (p, name) =>
  p.type.startsWith('tuple')
    ? `(${p.components.map((c) => named(c, c.name)).join(', ')})${p.type.slice(5)}${name ? ' ' + name : ''}`
    : `${p.type}${name ? ' ' + name : ''}`;

function findAbiEntry(abi, keyOrName) {
  const fns = abi.filter((f) => f.type === 'function');
  if (keyOrName.includes('(')) {
    const name = keyOrName.slice(0, keyOrName.indexOf('('));
    const types = keyOrName.slice(keyOrName.indexOf('(') + 1, -1);
    return fns.find((f) => f.name === name && f.inputs.map(typeOf).join(',') === types);
  }
  const matches = fns.filter((f) => f.name === keyOrName);
  if (matches.length !== 1) throw new Error(`${keyOrName}: ${matches.length} ABI matches, use a typed key`);
  return matches[0];
}

mkdirSync(`${OUT}/testsv2`, { recursive: true });
const summary = [];
for (const spec of SPECS) {
  const abi = JSON.parse(readFileSync(spec.abiFile, 'utf8'));
  const formats = {};
  const tests = [];
  const expectedFile = `expected/calldata-${spec.name}.json`;
  const expected = existsSync(expectedFile) ? JSON.parse(readFileSync(expectedFile, 'utf8')) : {};
  for (const [keyOrName, fmt] of Object.entries(spec.formats)) {
    const entry = findAbiEntry(abi, keyOrName);
    if (!entry) throw new Error(`${spec.name}: ${keyOrName} not in ABI`);
    const canonical = `${entry.name}(${entry.inputs.map(typeOf).join(',')})`;
    const names = spec.paramNames?.[canonical] ?? entry.inputs.map((i) => i.name);
    names.forEach((n, i) => {
      if (!n) throw new Error(`${canonical}: parameter ${i} has no name; add it to paramNames`);
    });
    const key = `${entry.name}(${entry.inputs.map((p, i) => named(p, names[i])).join(', ')})`;
    if (fmt.intent.length > MAX_INTENT) throw new Error(`${canonical}: intent "${fmt.intent}" exceeds ${MAX_INTENT} characters`);
    for (const f of fmt.fields.flatMap((f) => f.fields ?? [f])) {
      if (f.visible !== 'never' && f.label.length > MAX_LABEL) throw new Error(`${canonical}: label "${f.label}" exceeds ${MAX_LABEL} characters`);
    }
    formats[key] = {
      $id: entry.name,
      intent: fmt.intent,
      ...(fmt.interpolatedIntent ? { interpolatedIntent: fmt.interpolatedIntent } : {}),
      fields: fmt.fields
    };
    const abiItem = { ...entry, inputs: entry.inputs.map((p, i) => ({ ...p, name: names[i] })) };
    for (const [i, t] of fmt.tests.entries()) {
      const data = encodeFunctionData({ abi: [abiItem], functionName: entry.name, args: t.args });
      const rawTx = serializeTransaction({
        type: 'eip1559',
        chainId: 1,
        nonce: 41 + i,
        maxPriorityFeePerGas: 1_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        gas: 600_000n,
        to: spec.deployments[0].address,
        value: t.value ?? 0n,
        data
      });
      const exp = expected[t.description];
      tests.push({ description: t.description, rawTx, ...(exp ? { expected: exp } : { expected: { intent: fmt.intent, owner: OWNER, fields: [] } }) });
      summary.push(`${spec.name}.${entry.name} ${toFunctionSelector(abiItem)} ${t.description}`);
    }
  }
  const descriptor = {
    $schema: '../../specs/erc7730-v2.schema.json',
    context: { $id: spec.name, contract: { deployments: spec.deployments } },
    metadata: {
      owner: OWNER,
      info: INFO,
      contractName: spec.name,
      ...(spec.enums ? { enums: spec.enums } : {})
    },
    display: { formats }
  };
  writeFileSync(`${OUT}/calldata-${spec.name}.json`, JSON.stringify(descriptor, null, 2) + '\n');
  writeFileSync(
    `${OUT}/testsv2/calldata-${spec.name}.tests.json`,
    JSON.stringify(
      { $schema: '../../../specs/erc7730-tests-v2.schema.json', descriptor: `../calldata-${spec.name}.json`, dataProvider, tests },
      null,
      2
    ) + '\n'
  );
}
console.log(summary.join('\n'));
