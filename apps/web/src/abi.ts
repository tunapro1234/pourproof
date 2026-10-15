// The part of the PourLedger ABI the web app reads: events, view functions and custom errors. Written by hand so the
// site builds without the forge output; test/abi.test.ts checks every item against contracts/out.
import { parseAbi } from "viem";

export const LEDGER_EVENTS = parseAbi([
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event PourCreated(bytes32 indexed pourId, address indexed supplier, bytes32 ticketHash, bytes32 epdHash, uint32 volumeDm3, uint32 gwpLow, uint32 gwpHigh, uint64 pourStart)",
  "event BaselineDeclared(bytes32 indexed pourId, address indexed contractor, bytes32 baselineMixHash, uint32 baselineGwpLow, uint32 baselineGwpHigh)",
  "event PourAccepted(bytes32 indexed pourId, address indexed contractor)",
  "event DeviceRegistered(bytes32 indexed pourId, bytes32 qx, bytes32 qy, string deviceKind)",
  "event DeviceReplaced(bytes32 indexed pourId, bytes32 oldQx, bytes32 oldQy, bytes32 qx, bytes32 qy, string deviceKind)",
  "event BatchAppended(bytes32 indexed pourId, uint64 counter, uint64 fromTs, uint64 toTs, bytes32 root)",
  "event StrengthApproved(bytes32 indexed pourId, bytes32 evidenceHash)",
  "event SavingClaimed(bytes32 indexed pourId, address indexed claimant, bytes32 role, uint256 savingLow_kg, uint256 savingHigh_kg)",
]);

export const LEDGER_READS = parseAbi([
  "struct Pour { address supplier; uint64 pourStart; uint32 volumeDm3; uint32 gwpLow; uint32 gwpHigh; address contractor; uint64 nextCounter; bool strengthApproved; address claimant; bytes32 ticketHash; bytes32 epdHash; bytes32 evidenceHash; }",
  "struct Baseline { address contractor; uint32 gwpLow; uint32 gwpHigh; bytes32 mixHash; }",
  "struct Device { bytes32 qx; bytes32 qy; string kind; }",
  "function pour(bytes32 pourId) view returns (Pour)",
  "function baseline(bytes32 pourId) view returns (Baseline)",
  "function deviceOf(bytes32 pourId) view returns (Device)",
  "function nextCounter(bytes32 pourId) view returns (uint64)",
  "function savingRange(bytes32 pourId) view returns (uint256 low_kg, uint256 high_kg)",
  "function claimSaving(bytes32 pourId)",
]);

export const LEDGER_ERRORS = parseAbi([
  "error BadSignature()",
  "error CounterGap(bytes32 pourId, uint64 expected, uint64 got)",
  "error AlreadyClaimed(bytes32 pourId, address firstClaimant)",
  "error NotBeforePour(bytes32 pourId, uint64 pourStart)",
  "error StrengthNotApproved(bytes32 pourId)",
  "error NoBaseline(bytes32 pourId)",
  "error NotAClaimant(bytes32 pourId, address account)",
  "error FutureBatch(uint64 toTs, uint256 blockTime)",
  "error UnknownPour(bytes32 pourId)",
  "error TicketReused(bytes32 ticketHash, bytes32 firstPourId)",
]);

export const LEDGER_ABI = [...LEDGER_EVENTS, ...LEDGER_READS, ...LEDGER_ERRORS];
