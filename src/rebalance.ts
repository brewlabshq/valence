import fs from 'fs';
import readline from 'readline';
import { PublicKey } from '@solana/web3.js';
import { connection } from './config.ts';
import { dumpPoolValidatorData, fetchValidatorName } from './pool-fetcher.ts';

const VOTE_PROGRAM_ID = new PublicKey('Vote111111111111111111111111111111111111111');

interface ValidatorData {
	voteAccount: string;
	name?: string;
	stakeAccount: string;
	activeBalance: number;
	activeBalanceLamports: string;
	transientStakeAccount: string;
	transientBalance: number;
	transientBalanceLamports: string;
	// For editing
	targetBalance?: number;
	action?: 'remove' | 'keep' | 'add';
}

interface PoolData {
	reserveAccount: string;
	reserveBalance: number;
	validators: ValidatorData[];
}

interface EditState {
	validators: ValidatorData[];
	newValidators: ValidatorData[];
	reserveAccount: string;
	reserveBalance: number;
}

const DATA_FILE = 'data.json';
const OUTPUT_FILE = 'desired-state.json';
const POOL_ADDRESS = process.env.POOL_ADDRESS || 'DpooSqZRL3qCmiq82YyB4zWmLfH3iEqx2gy8f2B6zjru';
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

// Colors for terminal
const colors = {
	reset: '\x1b[0m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	cyan: '\x1b[36m',
	dim: '\x1b[2m',
	bold: '\x1b[1m',
};

function loadData(): { validators: ValidatorData[]; reserveAccount: string; reserveBalance: number } {
	const raw = fs.readFileSync(DATA_FILE, 'utf8');
	const poolData = JSON.parse(raw) as PoolData;
	// Initialize each with action and target
	const validators = poolData.validators.map((v) => ({
		...v,
		targetBalance: v.activeBalance,
		action: 'keep' as const,
	}));
	return {
		validators,
		reserveAccount: poolData.reserveAccount,
		reserveBalance: poolData.reserveBalance,
	};
}

function clearScreen() {
	console.clear();
}

function shortAddress(addr: string): string {
	return addr.slice(0, 8) + '...' + addr.slice(-4);
}

function shortName(name: string | undefined, maxLen: number = 20): string {
	if (!name) return 'Unknown'.padEnd(maxLen);
	if (name.length <= maxLen) return name.padEnd(maxLen);
	return name.slice(0, maxLen - 2) + '..';
}

function formatSOL(amount: number): string {
	return amount.toLocaleString('en-US', {
		minimumFractionDigits: 9,
		maximumFractionDigits: 9,
	});
}

function printHeader(state: EditState) {
	const totalCurrent = state.validators.reduce((s, v) => s + v.activeBalance, 0);
	const totalTarget = state.validators
		.filter((v) => v.action !== 'remove')
		.reduce((s, v) => s + (v.targetBalance ?? v.activeBalance), 0);
	const newValidatorStake = state.newValidators.reduce(
		(s, v) => s + (v.targetBalance ?? 0),
		0,
	);
	const totalWithNew = totalTarget + newValidatorStake;

	// Calculate removed stake (goes back to reserve)
	const removedValidators = state.validators.filter((v) => v.action === 'remove');
	const removedStake = removedValidators.reduce((s, v) => s + v.activeBalance, 0);

	// Calculate transient (pending) stake across all validators
	const totalTransient = state.validators.reduce((s, v) => s + (v.transientBalance ?? 0), 0);
	const validatorsWithTransient = state.validators.filter((v) => (v.transientBalance ?? 0) > 0).length;

	// Reserve calculations
	const availableReserve = state.reserveBalance + removedStake;
	const allocatedToNew = newValidatorStake;
	const remainingReserve = availableReserve - allocatedToNew;

	const totalPoolStake = totalCurrent + state.reserveBalance + totalTransient;

	console.log(colors.bold + '════════════════════════════════════════════════════════════════════════════════════════════════════════' + colors.reset);
	console.log(colors.cyan + '                                    DynoSOL Pool Rebalance TUI                                          ' + colors.reset);
	console.log(colors.bold + '════════════════════════════════════════════════════════════════════════════════════════════════════════' + colors.reset);
	console.log();

	// ─── RESERVE & LIQUIDITY ────────────────────────────────────────────────────
	console.log(colors.bold + '  ┌─ Reserve & Liquidity ────────────────────────────────────────────────────────' + colors.reset);
	console.log(`  │  Current Reserve:     ${colors.blue}${formatSOL(state.reserveBalance).padStart(22)} SOL${colors.reset}`);
	if (removedStake > 0) {
		console.log(`  │  + From Removals:     ${colors.green}${formatSOL(removedStake).padStart(22)} SOL${colors.reset}  ${colors.dim}(${removedValidators.length} validator${removedValidators.length === 1 ? '' : 's'})${colors.reset}`);
		console.log(`  │  ─────────────────────────────────────────────────`);
		console.log(`  │  = Available:         ${colors.cyan}${formatSOL(availableReserve).padStart(22)} SOL${colors.reset}`);
	}
	if (allocatedToNew > 0) {
		console.log(`  │  − To New Validators: ${colors.yellow}${formatSOL(allocatedToNew).padStart(22)} SOL${colors.reset}  ${colors.dim}(${state.newValidators.length} validator${state.newValidators.length === 1 ? '' : 's'})${colors.reset}`);
		console.log(`  │  ─────────────────────────────────────────────────`);
		console.log(`  │  = Remaining:         ${remainingReserve >= 0 ? colors.green : colors.red}${formatSOL(remainingReserve).padStart(22)} SOL${colors.reset}`);
	}
	console.log(colors.bold + '  └───────────────────────────────────────────────────────────────────────────────' + colors.reset);
	console.log();

	// ─── STAKING OVERVIEW ───────────────────────────────────────────────────────
	console.log(colors.bold + '  ┌─ Staking Overview ───────────────────────────────────────────────────────────' + colors.reset);
	console.log(`  │  Active Stake:        ${colors.yellow}${formatSOL(totalCurrent).padStart(22)} SOL${colors.reset}`);
	if (totalTransient > 0) {
		console.log(`  │  ⏳ Transient Stake:   ${colors.yellow}${formatSOL(totalTransient).padStart(22)} SOL${colors.reset}  ${colors.dim}(${validatorsWithTransient} validator${validatorsWithTransient === 1 ? '' : 's'}, next epoch)${colors.reset}`);
	}
	console.log(`  │  Target Stake:        ${colors.green}${formatSOL(totalWithNew).padStart(22)} SOL${colors.reset}`);
	const stakeDiff = totalWithNew - totalCurrent;
	if (stakeDiff !== 0) {
		const diffColor = stakeDiff > 0 ? colors.green : colors.red;
		const diffSign = stakeDiff > 0 ? '+' : '';
		console.log(`  │  Change:              ${diffColor}${(diffSign + formatSOL(stakeDiff)).padStart(22)} SOL${colors.reset}`);
	}
	console.log(colors.bold + '  └───────────────────────────────────────────────────────────────────────────────' + colors.reset);
	console.log();

	// ─── POOL SUMMARY ───────────────────────────────────────────────────────────
	console.log(colors.bold + '  ┌─ Pool Summary ────────────────────────────────────────────────────────────────' + colors.reset);
	console.log(`  │  Pool Total:          ${colors.cyan}${formatSOL(totalPoolStake).padStart(22)} SOL${colors.reset}`);
	const activeCount = state.validators.filter((v) => v.action !== 'remove').length + state.newValidators.length;
	const removeCount = state.validators.filter((v) => v.action === 'remove').length;
	const newCount = state.newValidators.length;
	let validatorSummary = `${activeCount} active`;
	if (removeCount > 0) validatorSummary += `, ${removeCount} removing`;
	if (newCount > 0) validatorSummary += `, ${newCount} new`;
	console.log(`  │  Validators:          ${validatorSummary.padStart(22)}`);
	console.log(colors.bold + '  └───────────────────────────────────────────────────────────────────────────────' + colors.reset);
	console.log();
}

function printNewValidatorsPanel(state: EditState) {
	if (state.newValidators.length === 0) return;

	const total = state.newValidators.reduce(
		(s, v) => s + (v.targetBalance ?? 0),
		0,
	);
	console.log(colors.cyan + '  ┌─ New validators ─────────────────────────────────────────────────────────────────' + colors.reset);
	console.log(
		colors.dim +
			'  │  #    Name                   Vote Account            Target' +
			colors.reset,
	);
	console.log(colors.dim + '  ├──────────────────────────────────────────────────────────────────────────────────────' + colors.reset);

	for (let i = 0; i < state.newValidators.length; i++) {
		const v = state.newValidators[i];
		if (v === undefined) continue;
		const idx = state.validators.length + i + 1;
		const target = v.targetBalance ?? 0;
		console.log(
			`  │  ${String(idx).padStart(2)}   ${shortName(v.name, 20)}  ${shortAddress(v.voteAccount).padEnd(18)}  ${colors.green}${formatSOL(target)} SOL${colors.reset}`,
		);
	}

	console.log(colors.dim + '  ├──────────────────────────────────────────────────────────────────────────────────────' + colors.reset);
	console.log(
		`  │  Total: ${colors.green}${formatSOL(total)} SOL${colors.reset}  ${colors.dim}(${state.newValidators.length} validator${state.newValidators.length === 1 ? '' : 's'})${colors.reset}`,
	);
	console.log(colors.cyan + '  └──────────────────────────────────────────────────────────────────────────────────────' + colors.reset);
	console.log();
}

function printValidatorList(state: EditState) {
	const allValidators = [
		...state.validators.map((v, i) => ({ ...v, index: i, isNew: false })),
		...state.newValidators.map((v, i) => ({
			...v,
			index: state.validators.length + i,
			isNew: true,
		})),
	];

	// Sort by target balance ascending (lowest first)
	allValidators.sort(
		(a, b) => (a.targetBalance ?? a.activeBalance) - (b.targetBalance ?? b.activeBalance),
	);

	console.log(
		colors.dim +
			'  #    Name                   Vote Account       Current              Target             Transient           Action' +
			colors.reset,
	);
	console.log(colors.dim + '  ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────' + colors.reset);

	for (const v of allValidators) {
		const actionColor =
			v.action === 'remove'
				? colors.red
				: v.action === 'add' || v.isNew
					? colors.green
					: colors.dim;
		const actionText =
			v.action === 'remove'
				? 'REMOVE'
				: v.isNew
					? 'NEW'
					: v.targetBalance !== v.activeBalance
						? 'MODIFY'
						: 'keep';

		const diffAmount = (v.targetBalance ?? v.activeBalance) - v.activeBalance;
		const diffStr =
			diffAmount !== 0
				? ` (${diffAmount >= 0 ? '+' : ''}${formatSOL(diffAmount)})`
				: '';

		// Show transient stake if any (pending activation next epoch)
		const transient = v.transientBalance ?? 0;
		const transientStr =
			transient > 0
				? `${colors.yellow}${formatSOL(transient).padStart(18)}${colors.reset}`
				: colors.dim + '                 -' + colors.reset;

		console.log(
			`  ${String(v.index + 1).padStart(2)}   ${shortName(v.name, 20)}  ${shortAddress(v.voteAccount)}  ${formatSOL(v.activeBalance).padStart(18)}  ${formatSOL(v.targetBalance ?? v.activeBalance).padStart(18)}   ${transientStr}   ${actionColor}${actionText}${colors.reset}${diffStr}`,
		);
	}

	console.log();
	console.log(
		colors.dim +
			`  Total: ${allValidators.length} validators` +
			colors.reset,
	);
	if (state.newValidators.length > 0) {
		const newTotal = state.newValidators.reduce(
			(s, v) => s + (v.targetBalance ?? 0),
			0,
		);
		console.log(
			colors.dim +
				`  New validators total: ${colors.green}${formatSOL(newTotal)} SOL${colors.reset} ${colors.dim}(${state.newValidators.length} validator${state.newValidators.length === 1 ? '' : 's'})${colors.reset}`,
		);
	}
	// Show validators with transient stake
	const withTransient = allValidators.filter((v) => (v.transientBalance ?? 0) > 0);
	if (withTransient.length > 0) {
		const totalTransient = withTransient.reduce((s, v) => s + (v.transientBalance ?? 0), 0);
		console.log(
			colors.yellow +
				`  ⏳ ${withTransient.length} validator${withTransient.length === 1 ? '' : 's'} with pending stake: ${formatSOL(totalTransient)} SOL (activates next epoch)` +
				colors.reset,
		);
	}
}

function printMenu() {
	console.log();
	console.log(colors.bold + '  Commands:' + colors.reset);
	console.log('  [r #]     Remove validator by number (e.g., r 5)');
	console.log('  [u #]     Undo remove (e.g., u 5)');
	console.log('  [s # AMT] Set target stake to AMT (e.g., s 5 8000)');
	console.log('  [+ # AMT] Add AMT to validator (target = current + AMT, e.g., + 4 1000)');
	console.log('  [- # AMT] Decrease AMT from validator (target = current - AMT, e.g., - 4 1000)');
	console.log('  [a VOTE]  Add new validator');
	console.log('  [b]       Auto-rebalance (redistribute from removed to lowest)');
	console.log('  [v]       Validate totals');
	console.log('  [w]       Write/Save to ' + OUTPUT_FILE);
	console.log('  [q]       Quit');
	console.log();
}

// Round to lamport precision (9 decimal places)
function roundToLamports(sol: number): number {
	return Math.round(sol * 1_000_000_000) / 1_000_000_000;
}

const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

/** Validate address as vote account or validator identity; resolve to vote account if needed. */
async function validateVoteAccount(
	input: string,
): Promise<{ valid: boolean; voteAccount: string; error?: string }> {
	try {
		const pubkey = new PublicKey(input);
		const { current, delinquent } = await connection.getVoteAccounts();
		const all = [...current, ...delinquent];
		const byVote = all.find((a) => a.votePubkey === input);
		const byNode = all.find((a) => a.nodePubkey === input);

		if (byVote) {
			return { valid: true, voteAccount: input };
		}
		if (byNode) {
			return { valid: true, voteAccount: byNode.votePubkey };
		}

		// Not in vote accounts list – check chain
		const info = await connection.getAccountInfo(pubkey);
		if (!info) {
			return { valid: false, voteAccount: input, error: 'Account not found on chain' };
		}
		if (info.owner.equals(VOTE_PROGRAM_ID)) {
			return {
				valid: false,
				voteAccount: input,
				error: 'Vote account not in active validator set (closed or inactive)',
			};
		}
		if (info.owner.equals(SYSTEM_PROGRAM_ID)) {
			return {
				valid: false,
				voteAccount: input,
				error: 'Address is a validator identity but not in active set. Use the vote account address instead.',
			};
		}
		return {
			valid: false,
			voteAccount: input,
			error: `Not a vote account (owner: ${info.owner.toBase58()})`,
		};
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes('invalid') || msg.includes('decode')) {
			return { valid: false, voteAccount: input, error: 'Invalid address (bad base58 or length)' };
		}
		return { valid: false, voteAccount: input, error: msg };
	}
}

function autoRebalance(state: EditState): EditState {
	// Get stake being removed
	const removedStake = state.validators
		.filter((v) => v.action === 'remove')
		.reduce((s, v) => s + v.activeBalance, 0);

	if (removedStake === 0) {
		console.log(colors.yellow + '  No validators marked for removal.' + colors.reset);
		return state;
	}

	// Get active validators sorted by current target (lowest first)
	const activeValidators = state.validators
		.filter((v) => v.action !== 'remove')
		.sort((a, b) => (a.targetBalance ?? a.activeBalance) - (b.targetBalance ?? b.activeBalance));

	if (activeValidators.length === 0) {
		console.log(colors.red + '  No active validators to distribute to!' + colors.reset);
		return state;
	}

	// Calculate target per validator
	const totalActiveStake = activeValidators.reduce(
		(s, v) => s + (v.targetBalance ?? v.activeBalance),
		0,
	);
	const newTotal = totalActiveStake + removedStake;
	const targetPerValidator = newTotal / activeValidators.length;

	// Distribute from bottom to top
	let remaining = removedStake;
	for (const v of activeValidators) {
		if (remaining <= 0) break;

		const currentTarget = v.targetBalance ?? v.activeBalance;
		const deficit = targetPerValidator - currentTarget;

		if (deficit > 0) {
			const toAdd = Math.min(deficit, remaining);
			v.targetBalance = roundToLamports(currentTarget + toAdd);
			remaining = roundToLamports(remaining - toAdd);
		}
	}

	// If there's still remaining, distribute equally from the top
	if (remaining > 0) {
		const perValidator = remaining / activeValidators.length;
		for (const v of activeValidators) {
			v.targetBalance = roundToLamports((v.targetBalance ?? v.activeBalance) + perValidator);
		}
	}

	console.log(
		colors.green +
			`  Redistributed ${formatSOL(removedStake)} SOL to ${activeValidators.length} validators` +
			colors.reset,
	);

	return state;
}

function validate(state: EditState): boolean {
	const totalCurrent = state.validators.reduce((s, v) => s + v.activeBalance, 0);
	const totalTarget = state.validators
		.filter((v) => v.action !== 'remove')
		.reduce((s, v) => s + (v.targetBalance ?? v.activeBalance), 0);
	const newValidatorStake = state.newValidators.reduce(
		(s, v) => s + (v.targetBalance ?? 0),
		0,
	);
	const totalWithNew = totalTarget + newValidatorStake;

	// Calculate how much stake is being decreased (goes to reserve)
	const decreasedStake = state.validators
		.filter((v) => v.action !== 'remove')
		.reduce((s, v) => {
			const diff = v.activeBalance - (v.targetBalance ?? v.activeBalance);
			return s + (diff > 0 ? diff : 0);
		}, 0);

	// Calculate how much stake is being removed (goes to reserve)
	const removedStake = state.validators
		.filter((v) => v.action === 'remove')
		.reduce((s, v) => s + v.activeBalance, 0);

	// Available reserve = current reserve + removed stake + decreased stake
	const availableReserve = state.reserveBalance + removedStake + decreasedStake;

	// min = can decrease to nearly 0 (minimum 1 SOL per active validator for rent)
	const activeValidatorCount = state.validators.filter((v) => v.action !== 'remove').length + state.newValidators.length;
	const minStaked = activeValidatorCount; // ~1 SOL minimum per validator
	// max = current + reserve (can use all reserve for increases/new validators)
	const maxStaked = totalCurrent + state.reserveBalance;

	// Check if increases + new validators can be funded from available reserve
	const increasedStake = state.validators
		.filter((v) => v.action !== 'remove')
		.reduce((s, v) => {
			const diff = (v.targetBalance ?? v.activeBalance) - v.activeBalance;
			return s + (diff > 0 ? diff : 0);
		}, 0);
	const totalNeeded = increasedStake + newValidatorStake;

	if (totalNeeded > availableReserve + 0.01) {
		console.log(
			colors.red +
				`  ✗ Validation FAILED! Need ${formatSOL(totalNeeded)} SOL but only ${formatSOL(availableReserve)} SOL available (reserve + decreases + removals)` +
				colors.reset,
		);
		return false;
	}

	if (totalWithNew < minStaked - 0.01) {
		console.log(
			colors.red +
				`  ✗ Validation FAILED! Target staked ${formatSOL(totalWithNew)} SOL is below minimum ${formatSOL(minStaked)} SOL (1 SOL per validator)` +
				colors.reset,
		);
		return false;
	}

	console.log(colors.green + '  ✓ Validation PASSED! Totals match.' + colors.reset);
	return true;
}

function saveState(state: EditState) {
	const output = {
		generated: new Date().toISOString(),
		summary: {
			totalValidators:
				state.validators.filter((v) => v.action !== 'remove').length +
				state.newValidators.length,
			toRemove: state.validators.filter((v) => v.action === 'remove').length,
			toAdd: state.newValidators.length,
			toModify: state.validators.filter(
				(v) => v.action !== 'remove' && v.targetBalance !== v.activeBalance,
			).length,
		},
		removals: state.validators
			.filter((v) => v.action === 'remove')
			.map((v) => ({
				voteAccount: v.voteAccount,
				stakeAccount: v.stakeAccount,
				currentBalance: v.activeBalance,
			})),
		additions: state.newValidators.map((v) => ({
			voteAccount: v.voteAccount,
			targetBalance: v.targetBalance,
		})),
		modifications: state.validators
			.filter((v) => v.action !== 'remove' && v.targetBalance !== v.activeBalance)
			.map((v) => ({
				voteAccount: v.voteAccount,
				stakeAccount: v.stakeAccount,
				currentBalance: v.activeBalance,
				targetBalance: v.targetBalance,
				change: (v.targetBalance ?? v.activeBalance) - v.activeBalance,
			})),
		validators: state.validators
			.filter((v) => v.action !== 'remove')
			.map((v) => ({
				voteAccount: v.voteAccount,
				stakeAccount: v.stakeAccount,
				activeBalance: v.activeBalance,
				targetBalance: v.targetBalance ?? v.activeBalance,
			})),
	};

	fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
	console.log(colors.green + `  ✓ Saved to ${OUTPUT_FILE}` + colors.reset);

	// Generate bash scripts
	generateBashScripts(state, output);
}

// Convert SOL to lamports and back to get clean 9 decimal places
function toCleanSOL(sol: number): string {
	const lamports = Math.round(sol * 1_000_000_000);
	return (lamports / 1_000_000_000).toFixed(9);
}

function generateBashScripts(state: EditState, output: any) {
	const date = new Date().toISOString().split('T')[0];
	const folderName = `rebalance/${date}`;

	fs.mkdirSync(folderName, { recursive: true });

	// Collect validators to fully remove
	const removeOps: Array<{ voteAccount: string; amount: number; name?: string }> = [];
	for (const removal of output.removals) {
		const validator = state.validators.find((v) => v.voteAccount === removal.voteAccount);
		removeOps.push({
			voteAccount: removal.voteAccount,
			amount: removal.currentBalance,
			name: validator?.name,
		});
	}

	// Collect all increase operations (modifications with positive change + new validators with target stake)
	const increaseOps: Array<{ voteAccount: string; amount: number; name?: string }> = [];
	for (const mod of output.modifications ?? []) {
		if (mod.change > 0) {
			const validator = state.validators.find((v) => v.voteAccount === mod.voteAccount);
			increaseOps.push({
				voteAccount: mod.voteAccount,
				amount: mod.change,
				name: validator?.name,
			});
		}
	}
	for (const add of output.additions ?? []) {
		const amount = add.targetBalance ?? 0;
		if (amount > 0) {
			const newV = state.newValidators.find((v) => v.voteAccount === add.voteAccount);
			increaseOps.push({
				voteAccount: add.voteAccount,
				amount,
				name: newV?.name,
			});
		}
	}

	// Collect all decrease operations (modifications with negative change)
	const decreaseOps: Array<{ voteAccount: string; amount: number; name?: string }> = [];
	for (const mod of output.modifications ?? []) {
		if (mod.change < 0) {
			const validator = state.validators.find((v) => v.voteAccount === mod.voteAccount);
			decreaseOps.push({
				voteAccount: mod.voteAccount,
				amount: Math.abs(mod.change),
				name: validator?.name,
			});
		}
	}

	// Script 1: Remove validators from pool (stake is withdrawn automatically)
	if (removeOps.length > 0) {
		let script1 = '#!/bin/bash\n\n';
		script1 += '# Script 1: Remove validators from pool\n';
		script1 += `# Generated: ${new Date().toISOString()}\n`;
		script1 += `# Pool: ${POOL_ADDRESS}\n`;
		script1 += `# Validators to remove: ${removeOps.length}\n`;
		script1 += '#\n';
		script1 += '# Usage: bash 01_remove_validators.sh /path/to/manager_keypair.json [rpc_url] [staker_keypair.json]\n';
		script1 += '# If staker_keypair is omitted, manager keypair is used as staker.\n\n';
		script1 += 'set -e\n\n';
		script1 += 'KEYPAIR="$1"\n';
		script1 += 'RPC_URL="${2:-https://api.mainnet-beta.solana.com}"\n';
		script1 += 'STAKER_KEYPAIR="${3:-$KEYPAIR}"\n\n';
		script1 += 'if [ -z "$KEYPAIR" ]; then\n';
		script1 += '    echo "Usage: bash $0 /path/to/keypair.json [rpc_url] [staker_keypair.json]"\n';
		script1 += '    exit 1\n';
		script1 += 'fi\n\n';
		script1 += 'echo "Using keypair (manager): $KEYPAIR"\n';
		script1 += 'echo "Using RPC: $RPC_URL"\n';
		script1 += 'echo "Using staker keypair: $STAKER_KEYPAIR"\n';
		script1 += 'echo ""\n\n';

		for (const op of removeOps) {
			const nameComment = op.name ? op.name : 'Unknown';
			const cleanAmount = toCleanSOL(op.amount);

			script1 += `echo "Removing validator: ${nameComment}"\n`;
			script1 += `echo "Vote Account: ${op.voteAccount}"\n`;
			script1 += `echo "Current Balance: ${cleanAmount} SOL"\n\n`;

			script1 += `spl-stake-pool remove-validator ${POOL_ADDRESS} ${op.voteAccount} \\\n`;
			script1 += `    --url "$RPC_URL" \\\n`;
			script1 += `    --manager "$KEYPAIR" \\\n`;
			script1 += `    --fee-payer "$KEYPAIR" \\\n`;
			script1 += `    --staker "$STAKER_KEYPAIR"\n\n`;

			script1 += `echo "----------------------------------------"\n\n`;
		}

		const file1 = `${folderName}/01_remove_validators.sh`;
		fs.writeFileSync(file1, script1, 'utf8');
		fs.chmodSync(file1, '755');
		console.log(colors.green + `  ✓ Generated ${file1} (${removeOps.length} validators)` + colors.reset);
	} else {
		console.log(colors.dim + '  No validators to remove' + colors.reset);
	}

	// Script 2: Add new validators to pool (run before increase-stake so new validators get stake)
	const addValidatorOps = (output.additions ?? []).map((add: any) => {
		const newV = state.newValidators.find((v) => v.voteAccount === add.voteAccount);
		return {
			voteAccount: add.voteAccount,
			amount: add.targetBalance ?? 0,
			name: newV?.name,
		};
	});
	if (addValidatorOps.length > 0) {
		let script2 = '#!/bin/bash\n\n';
		script2 += '# Script 2: Add new validators to pool\n';
		script2 += `# Generated: ${new Date().toISOString()}\n`;
		script2 += `# Pool: ${POOL_ADDRESS}\n`;
		script2 += `# Validators to add: ${addValidatorOps.length}\n`;
		script2 += '#\n';
		script2 += '# Usage: bash 02_add_validators.sh /path/to/manager_keypair.json [rpc_url] [staker_keypair.json]\n';
		script2 += '# If staker_keypair is omitted, manager keypair is used as staker.\n';
		script2 += '# Run 03_increase_stake.sh after this to allocate stake to new validators.\n\n';
		script2 += 'set -e\n\n';
		script2 += 'KEYPAIR="$1"\n';
		script2 += 'RPC_URL="${2:-https://api.mainnet-beta.solana.com}"\n';
		script2 += 'STAKER_KEYPAIR="${3:-$KEYPAIR}"\n\n';
		script2 += 'if [ -z "$KEYPAIR" ]; then\n';
		script2 += '    echo "Usage: bash $0 /path/to/keypair.json [rpc_url] [staker_keypair.json]"\n';
		script2 += '    exit 1\n';
		script2 += 'fi\n\n';
		script2 += 'echo "Using keypair (manager): $KEYPAIR"\n';
		script2 += 'echo "Using RPC: $RPC_URL"\n';
		script2 += 'echo "Using staker keypair: $STAKER_KEYPAIR"\n';
		script2 += 'echo ""\n\n';

		for (const op of addValidatorOps) {
			const nameComment = op.name ? op.name : 'Unknown';
			const cleanAmount = toCleanSOL(op.amount);
			script2 += `echo "Adding validator: ${nameComment}"\n`;
			script2 += `echo "Vote Account: ${op.voteAccount}"\n`;
			script2 += `echo "Target stake (set in 03): ${cleanAmount} SOL"\n\n`;

			script2 += `spl-stake-pool add-validator ${POOL_ADDRESS} ${op.voteAccount} \\\n`;
			script2 += `    --url "$RPC_URL" \\\n`;
			script2 += `    --manager "$KEYPAIR" \\\n`;
			script2 += `    --fee-payer "$KEYPAIR" \\\n`;
			script2 += `    --staker "$STAKER_KEYPAIR"\n\n`;

			script2 += `echo "----------------------------------------"\n\n`;
		}

		const file2 = `${folderName}/02_add_validators.sh`;
		fs.writeFileSync(file2, script2, 'utf8');
		fs.chmodSync(file2, '755');
		console.log(colors.green + `  ✓ Generated ${file2} (${addValidatorOps.length} validators)` + colors.reset);
	} else {
		console.log(colors.dim + '  No new validators to add' + colors.reset);
	}

	// Script 3: Increase stake to validators (existing + new)
	if (increaseOps.length > 0) {
		let script3 = '#!/bin/bash\n\n';
		script3 += '# Script 3: Increase stake to validators (redistribute removed stake + new validator stake)\n';
		script3 += `# Generated: ${new Date().toISOString()}\n`;
		script3 += `# Pool: ${POOL_ADDRESS}\n`;
		script3 += `# Validators to increase: ${increaseOps.length}\n`;
		script3 += '#\n';
		script3 += '# Usage: bash 03_increase_stake.sh /path/to/manager_keypair.json [rpc_url] [staker_keypair.json]\n';
		script3 += '# If staker_keypair is omitted, manager keypair is used as staker.\n\n';
		script3 += 'set -e\n\n';
		script3 += 'KEYPAIR="$1"\n';
		script3 += 'RPC_URL="${2:-https://api.mainnet-beta.solana.com}"\n';
		script3 += 'STAKER_KEYPAIR="${3:-$KEYPAIR}"\n\n';
		script3 += 'if [ -z "$KEYPAIR" ]; then\n';
		script3 += '    echo "Usage: bash $0 /path/to/keypair.json [rpc_url] [staker_keypair.json]"\n';
		script3 += '    exit 1\n';
		script3 += 'fi\n\n';
		script3 += 'echo "Using keypair (manager): $KEYPAIR"\n';
		script3 += 'echo "Using RPC: $RPC_URL"\n';
		script3 += 'echo "Using staker keypair: $STAKER_KEYPAIR"\n';
		script3 += 'echo ""\n\n';

		for (const op of increaseOps) {
			const nameComment = op.name ? op.name : 'Unknown';
			const cleanAmount = toCleanSOL(op.amount);
			script3 += `echo "Increasing stake for: ${nameComment}"\n`;
			script3 += `echo "Vote Account: ${op.voteAccount}"\n`;
			script3 += `echo "Amount to add: ${cleanAmount} SOL"\n\n`;

			script3 += `spl-stake-pool increase-validator-stake ${POOL_ADDRESS} ${op.voteAccount} ${cleanAmount} \\\n`;
			script3 += `    --url "$RPC_URL" \\\n`;
			script3 += `    --manager "$KEYPAIR" \\\n`;
			script3 += `    --fee-payer "$KEYPAIR" \\\n`;
			script3 += `    --staker "$STAKER_KEYPAIR"\n\n`;

			script3 += `echo "----------------------------------------"\n\n`;
		}

		const file3 = `${folderName}/03_increase_stake.sh`;
		fs.writeFileSync(file3, script3, 'utf8');
		fs.chmodSync(file3, '755');
		console.log(colors.green + `  ✓ Generated ${file3} (${increaseOps.length} validators)` + colors.reset);
	} else {
		console.log(colors.dim + '  No increase operations needed' + colors.reset);
	}

	// Script 4: Decrease stake from validators (stake goes to reserve)
	if (decreaseOps.length > 0) {
		let script4 = '#!/bin/bash\n\n';
		script4 += '# Script 4: Decrease stake from validators (stake returns to reserve)\n';
		script4 += `# Generated: ${new Date().toISOString()}\n`;
		script4 += `# Pool: ${POOL_ADDRESS}\n`;
		script4 += `# Validators to decrease: ${decreaseOps.length}\n`;
		script4 += '#\n';
		script4 += '# Usage: bash 04_decrease_stake.sh /path/to/manager_keypair.json [rpc_url] [staker_keypair.json]\n';
		script4 += '# If staker_keypair is omitted, manager keypair is used as staker.\n';
		script4 += '# Note: Decreased stake goes to transient account, then merges to reserve next epoch.\n\n';
		script4 += 'set -e\n\n';
		script4 += 'KEYPAIR="$1"\n';
		script4 += 'RPC_URL="${2:-https://api.mainnet-beta.solana.com}"\n';
		script4 += 'STAKER_KEYPAIR="${3:-$KEYPAIR}"\n\n';
		script4 += 'if [ -z "$KEYPAIR" ]; then\n';
		script4 += '    echo "Usage: bash $0 /path/to/keypair.json [rpc_url] [staker_keypair.json]"\n';
		script4 += '    exit 1\n';
		script4 += 'fi\n\n';
		script4 += 'echo "Using keypair (manager): $KEYPAIR"\n';
		script4 += 'echo "Using RPC: $RPC_URL"\n';
		script4 += 'echo "Using staker keypair: $STAKER_KEYPAIR"\n';
		script4 += 'echo ""\n\n';

		for (const op of decreaseOps) {
			const nameComment = op.name ? op.name : 'Unknown';
			const cleanAmount = toCleanSOL(op.amount);
			script4 += `echo "Decreasing stake for: ${nameComment}"\n`;
			script4 += `echo "Vote Account: ${op.voteAccount}"\n`;
			script4 += `echo "Amount to decrease: ${cleanAmount} SOL"\n\n`;

			script4 += `spl-stake-pool decrease-validator-stake ${POOL_ADDRESS} ${op.voteAccount} ${cleanAmount} \\\n`;
			script4 += `    --url "$RPC_URL" \\\n`;
			script4 += `    --manager "$KEYPAIR" \\\n`;
			script4 += `    --fee-payer "$KEYPAIR" \\\n`;
			script4 += `    --staker "$STAKER_KEYPAIR"\n\n`;

			script4 += `echo "----------------------------------------"\n\n`;
		}

		const file4 = `${folderName}/04_decrease_stake.sh`;
		fs.writeFileSync(file4, script4, 'utf8');
		fs.chmodSync(file4, '755');
		console.log(colors.green + `  ✓ Generated ${file4} (${decreaseOps.length} validators)` + colors.reset);
	} else {
		console.log(colors.dim + '  No decrease operations needed' + colors.reset);
	}

	console.log(colors.green + `  ✓ Scripts saved to ${folderName}/` + colors.reset);
}

async function main() {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	const prompt = (query: string): Promise<string> =>
		new Promise((resolve) => rl.question(query, resolve));

	// Fetch fresh data from chain
	console.log(colors.cyan + '  Fetching latest pool data from chain...' + colors.reset);
	try {
		await dumpPoolValidatorData(DATA_FILE);
		console.log(colors.green + '  ✓ Data updated!' + colors.reset);
	} catch (error: any) {
		console.log(colors.red + `  ✗ Failed to fetch: ${error?.message}` + colors.reset);
		console.log(colors.yellow + '  Using existing data.json...' + colors.reset);
	}

	// Load initial data
	const { validators, reserveAccount, reserveBalance } = loadData();
	let state: EditState = {
		validators,
		newValidators: [],
		reserveAccount,
		reserveBalance,
	};

	while (true) {
		clearScreen();
		printHeader(state);
		printNewValidatorsPanel(state);
		printValidatorList(state);
		printMenu();

		const input = await prompt('  > ');
		const parts = input.trim().split(/\s+/);
		const cmd = parts[0]?.toLowerCase();

		if (cmd === 'q') {
			console.log('  Goodbye!');
			rl.close();
			process.exit(0);
		} else if (cmd === 'r' && parts[1]) {
			const idx = parseInt(parts[1], 10) - 1;
			const v = state.validators[idx];
			if (v !== undefined && idx >= 0) {
				v.action = 'remove';
				v.targetBalance = 0;
			} else {
				console.log(colors.red + '  Invalid validator number' + colors.reset);
				await prompt('  Press Enter to continue...');
			}
		} else if (cmd === 'u' && parts[1]) {
			const idx = parseInt(parts[1], 10) - 1;
			const v = state.validators[idx];
			if (v !== undefined && idx >= 0) {
				v.action = 'keep';
				v.targetBalance = v.activeBalance;
			}
		} else if (cmd === 's' && parts[1] && parts[2]) {
			const idx = parseInt(parts[1], 10) - 1;
			const amount = parseFloat(parts[2]);
			const v = state.validators[idx];
			if (v !== undefined && idx >= 0 && !isNaN(amount)) {
				v.targetBalance = amount;
			} else if (
				idx >= state.validators.length &&
				idx < state.validators.length + state.newValidators.length &&
				!isNaN(amount)
			) {
				const newIdx = idx - state.validators.length;
				const nv = state.newValidators[newIdx];
				if (nv !== undefined) nv.targetBalance = amount;
			}
		} else if ((cmd === '+' || cmd === 'add') && parts[1] && parts[2]) {
			const idx = parseInt(parts[1], 10) - 1;
			const addAmount = parseFloat(parts[2]);
			const v = state.validators[idx];
			if (v !== undefined && idx >= 0 && !isNaN(addAmount)) {
				if (v.action === 'remove') {
					console.log(colors.red + '  Cannot add to a validator marked for removal. Undo with u # first.' + colors.reset);
					await prompt('  Press Enter to continue...');
				} else {
					const current = v.targetBalance ?? v.activeBalance;
					v.targetBalance = roundToLamports(current + addAmount);
				}
			} else if (
				idx >= state.validators.length &&
				idx < state.validators.length + state.newValidators.length &&
				!isNaN(addAmount)
			) {
				const newIdx = idx - state.validators.length;
				const nv = state.newValidators[newIdx];
				if (nv !== undefined) {
					const current = nv.targetBalance ?? 0;
					nv.targetBalance = roundToLamports(current + addAmount);
				}
			} else {
				console.log(colors.red + '  Invalid validator number or amount' + colors.reset);
				await prompt('  Press Enter to continue...');
			}
		} else if ((cmd === '-' || cmd === 'sub') && parts[1] && parts[2]) {
			const idx = parseInt(parts[1], 10) - 1;
			const subAmount = parseFloat(parts[2]);
			const v = state.validators[idx];
			if (v !== undefined && idx >= 0 && !isNaN(subAmount)) {
				if (v.action === 'remove') {
					console.log(colors.red + '  Cannot decrease a validator marked for removal. Undo with u # first.' + colors.reset);
					await prompt('  Press Enter to continue...');
				} else {
					const current = v.targetBalance ?? v.activeBalance;
					const newTarget = roundToLamports(current - subAmount);
					if (newTarget < 0) {
						console.log(colors.red + `  Cannot go below 0. Current target: ${formatSOL(current)} SOL` + colors.reset);
						await prompt('  Press Enter to continue...');
					} else {
						v.targetBalance = newTarget;
					}
				}
			} else if (
				idx >= state.validators.length &&
				idx < state.validators.length + state.newValidators.length &&
				!isNaN(subAmount)
			) {
				const newIdx = idx - state.validators.length;
				const nv = state.newValidators[newIdx];
				if (nv !== undefined) {
					const current = nv.targetBalance ?? 0;
					const newTarget = roundToLamports(current - subAmount);
					if (newTarget < 0) {
						console.log(colors.red + `  Cannot go below 0. Current target: ${formatSOL(current)} SOL` + colors.reset);
						await prompt('  Press Enter to continue...');
					} else {
						nv.targetBalance = newTarget;
					}
				}
			} else {
				console.log(colors.red + '  Invalid validator number or amount' + colors.reset);
				await prompt('  Press Enter to continue...');
			}
		} else if (cmd === 'a' && parts[1]) {
			const voteAccount = parts[1];
			// Check if already exists
			const exists =
				state.validators.some((v) => v.voteAccount === voteAccount) ||
				state.newValidators.some((v) => v.voteAccount === voteAccount);
			if (exists) {
				console.log(colors.red + '  Validator already exists!' + colors.reset);
				await prompt('  Press Enter to continue...');
			} else {
				console.log(colors.dim + '  Validating vote account on chain...' + colors.reset);
				const result = await validateVoteAccount(voteAccount);
				if (!result.valid) {
					console.log(colors.red + `  Invalid: ${result.error}` + colors.reset);
					await prompt('  Press Enter to continue...');
				} else {
					const toAdd = result.voteAccount;
					const alreadyExists =
						state.validators.some((v) => v.voteAccount === toAdd) ||
						state.newValidators.some((v) => v.voteAccount === toAdd);
					if (alreadyExists) {
						console.log(colors.red + '  That vote account is already in the pool.' + colors.reset);
						await prompt('  Press Enter to continue...');
					} else {
						const resolvedNote =
							toAdd !== voteAccount
								? colors.dim + `  (resolved from validator identity to vote account ${shortAddress(toAdd)})` + colors.reset
								: '';
						// Fetch validator name
						console.log(colors.dim + '  Fetching validator name...' + colors.reset);
						const validatorName = await fetchValidatorName(toAdd);
						state.newValidators.push({
							voteAccount: toAdd,
							name: validatorName ?? undefined,
							stakeAccount: '',
							activeBalance: 0,
							activeBalanceLamports: '0',
							transientStakeAccount: '',
							transientBalance: 0,
							transientBalanceLamports: '0',
							targetBalance: 0,
							action: 'add',
						});
						const nameDisplay = validatorName ? colors.cyan + validatorName + colors.reset : 'Unknown';
						console.log(
							colors.green + `  ✓ Added: ${nameDisplay}. Set stake with: s # AMOUNT` + colors.reset,
						);
						if (resolvedNote) console.log('  ' + resolvedNote);
						await prompt('  Press Enter to continue...');
					}
				}
			}
		} else if (cmd === 'b') {
			state = autoRebalance(state);
			await prompt('  Press Enter to continue...');
		} else if (cmd === 'v') {
			validate(state);
			await prompt('  Press Enter to continue...');
		} else if (cmd === 'w') {
			if (validate(state)) {
				saveState(state);
			}
			await prompt('  Press Enter to continue...');
		}
	}

	rl.close();
}

main();

