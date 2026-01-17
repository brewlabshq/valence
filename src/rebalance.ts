import fs from 'fs';
import readline from 'readline';
import { dumpPoolValidatorData } from './pool-fetcher.ts';

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
	currentPage: number;
	validatorsPerPage: number;
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
	const projectedReserve = state.reserveBalance + removedStake;

	const totalPoolStake = totalCurrent + state.reserveBalance;

	console.log(colors.bold + '════════════════════════════════════════════════════════════════════════════════════════════════════════' + colors.reset);
	console.log(colors.cyan + '                                    Stake Pool Rebalance TUI                                          ' + colors.reset);
	console.log(colors.bold + '════════════════════════════════════════════════════════════════════════════════════════════════════════' + colors.reset);
	console.log();
	console.log(`  Reserve Balance:   ${colors.blue}${formatSOL(state.reserveBalance)} SOL${colors.reset}  ${colors.dim}(${shortAddress(state.reserveAccount)})${colors.reset}`);
	if (removedStake > 0) {
		for (const v of removedValidators) {
			console.log(`  + ${colors.red}${shortName(v.name, 16)}${colors.reset}  ${colors.red}${formatSOL(v.activeBalance)} SOL${colors.reset}`);
		}
		console.log(`  = After Removals:  ${colors.green}${formatSOL(projectedReserve)} SOL${colors.reset}`);
	}
	console.log();
	console.log(`  Staked Total:      ${colors.yellow}${formatSOL(totalCurrent)} SOL${colors.reset}`);
	console.log(`  Target Staked:     ${colors.green}${formatSOL(totalWithNew)} SOL${colors.reset}`);
	console.log(`  Pool Total:        ${colors.cyan}${formatSOL(totalPoolStake)} SOL${colors.reset}`);
	console.log();
	console.log(
		`  Validators:        ${state.validators.filter((v) => v.action !== 'remove').length + state.newValidators.length} active, ${state.validators.filter((v) => v.action === 'remove').length} to remove`,
	);
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

	const totalValidators = allValidators.length;
	const totalPages = Math.max(1, Math.ceil(totalValidators / state.validatorsPerPage));
	const currentPage = Math.min(Math.max(1, state.currentPage), totalPages);
	const startIdx = (currentPage - 1) * state.validatorsPerPage;
	const endIdx = Math.min(startIdx + state.validatorsPerPage, totalValidators);
	const pageValidators = allValidators.slice(startIdx, endIdx);

	console.log(
		colors.dim +
			'  #    Name                   Vote Account       Current              Target             Action' +
			colors.reset,
	);
	console.log(colors.dim + '  ────────────────────────────────────────────────────────────────────────────────────────────────────────' + colors.reset);

	for (const v of pageValidators) {
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

		console.log(
			`  ${String(v.index + 1).padStart(2)}   ${shortName(v.name, 20)}  ${shortAddress(v.voteAccount)}  ${formatSOL(v.activeBalance).padStart(18)}  ${formatSOL(v.targetBalance ?? v.activeBalance).padStart(18)}   ${actionColor}${actionText}${colors.reset}${diffStr}`,
		);
	}

	console.log();
	console.log(
		colors.dim +
			`  Page ${currentPage}/${totalPages} (${totalValidators} validators)` +
			colors.reset,
	);
}

function printMenu() {
	console.log();
	console.log(colors.bold + '  Commands:' + colors.reset);
	console.log('  [n/p]     Next/Previous page');
	console.log('  [r #]     Remove validator by number (e.g., r 5)');
	console.log('  [u #]     Undo remove (e.g., u 5)');
	console.log('  [s # AMT] Set target stake (e.g., s 5 8000)');
	console.log('  [a VOTE]  Add new validator');
	console.log('  [b]       Auto-rebalance (redistribute from removed to lowest)');
	console.log('  [v]       Validate totals');
	console.log('  [w]       Write/Save to ' + OUTPUT_FILE);
	console.log('  [q]       Quit');
	console.log();
}

function normalizePage(state: EditState): void {
	const allValidators = [
		...state.validators,
		...state.newValidators,
	];
	const totalPages = Math.max(1, Math.ceil(allValidators.length / state.validatorsPerPage));
	if (state.currentPage > totalPages) {
		state.currentPage = Math.max(1, totalPages);
	}
}

// Round to lamport precision (9 decimal places)
function roundToLamports(sol: number): number {
	return Math.round(sol * 1_000_000_000) / 1_000_000_000;
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

	const diff = Math.abs(totalWithNew - totalCurrent);

	if (diff < 0.01) {
		console.log(colors.green + '  ✓ Validation PASSED! Totals match.' + colors.reset);
		return true;
	} else {
		console.log(
			colors.red +
				`  ✗ Validation FAILED! Difference: ${formatSOL(totalWithNew - totalCurrent)} SOL` +
				colors.reset,
		);
		return false;
	}
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
	const folderName = `rebalance_${date}`;

	if (!fs.existsSync(folderName)) {
		fs.mkdirSync(folderName);
	}

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

	// Collect all increase operations (modifications with positive change)
	const increaseOps: Array<{ voteAccount: string; amount: number; name?: string }> = [];
	for (const mod of output.modifications) {
		if (mod.change > 0) {
			const validator = state.validators.find((v) => v.voteAccount === mod.voteAccount);
			increaseOps.push({
				voteAccount: mod.voteAccount,
				amount: mod.change,
				name: validator?.name,
			});
		}
	}

	// Script 1: Decrease stake and remove validators
	// Minimum stake required (1 SOL + rent exemption ~0.00228288)
	const MIN_STAKE = 1.00228288;

	if (removeOps.length > 0) {
		let script1 = '#!/bin/bash\n\n';
		script1 += '# Script 1: Decrease stake and remove validators from pool\n';
		script1 += `# Generated: ${new Date().toISOString()}\n`;
		script1 += `# Pool: ${POOL_ADDRESS}\n`;
		script1 += `# Validators to remove: ${removeOps.length}\n`;
		script1 += '#\n';
		script1 += '# Usage: bash 01_decrease_and_remove.sh /path/to/keypair.json [rpc_url]\n\n';
		script1 += 'set -e\n\n';
		script1 += 'KEYPAIR="$1"\n';
		script1 += 'RPC_URL="${2:-https://api.mainnet-beta.solana.com}"\n\n';
		script1 += 'if [ -z "$KEYPAIR" ]; then\n';
		script1 += '    echo "Usage: bash $0 /path/to/keypair.json [rpc_url]"\n';
		script1 += '    exit 1\n';
		script1 += 'fi\n\n';
		script1 += 'echo "Using keypair: $KEYPAIR"\n';
		script1 += 'echo "Using RPC: $RPC_URL"\n';
		script1 += 'echo ""\n\n';

		for (const op of removeOps) {
			const nameComment = op.name ? op.name : 'Unknown';
			const cleanAmount = toCleanSOL(op.amount);
			// Calculate amount to decrease (leave minimum for rent exemption)
			const decreaseAmount = Math.max(0, op.amount - MIN_STAKE);
			const cleanDecreaseAmount = toCleanSOL(decreaseAmount);

			script1 += `echo "Removing validator: ${nameComment}"\n`;
			script1 += `echo "Vote Account: ${op.voteAccount}"\n`;
			script1 += `echo "Current Balance: ${cleanAmount} SOL"\n`;
			script1 += `echo "Decreasing by: ${cleanDecreaseAmount} SOL"\n\n`;

			// Decrease stake to minimum (leave 1 SOL + rent exemption)
			if (decreaseAmount > 0) {
				script1 += `spl-stake-pool decrease-validator-stake ${POOL_ADDRESS} ${op.voteAccount} ${cleanDecreaseAmount} \\\n`;
				script1 += `    --url "$RPC_URL" \\\n`;
				script1 += `    --manager "$KEYPAIR" \\\n`;
				script1 += `    --fee-payer "$KEYPAIR"\n\n`;
			}

			// Remove validator from pool
			script1 += `spl-stake-pool remove-validator ${POOL_ADDRESS} ${op.voteAccount} \\\n`;
			script1 += `    --url "$RPC_URL" \\\n`;
			script1 += `    --manager "$KEYPAIR" \\\n`;
			script1 += `    --fee-payer "$KEYPAIR"\n\n`;

			script1 += `echo "----------------------------------------"\n\n`;
		}

		const file1 = `${folderName}/01_decrease_and_remove.sh`;
		fs.writeFileSync(file1, script1, 'utf8');
		fs.chmodSync(file1, '755');
		console.log(colors.green + `  ✓ Generated ${file1} (${removeOps.length} validators)` + colors.reset);
	} else {
		console.log(colors.dim + '  No validators to remove' + colors.reset);
	}

	// Script 2: Increase stake to validators
	if (increaseOps.length > 0) {
		let script2 = '#!/bin/bash\n\n';
		script2 += '# Script 2: Increase stake to validators (redistribute removed stake)\n';
		script2 += `# Generated: ${new Date().toISOString()}\n`;
		script2 += `# Pool: ${POOL_ADDRESS}\n`;
		script2 += `# Validators to increase: ${increaseOps.length}\n`;
		script2 += '#\n';
		script2 += '# Usage: bash 02_increase_stake.sh /path/to/keypair.json [rpc_url]\n\n';
		script2 += 'set -e\n\n';
		script2 += 'KEYPAIR="$1"\n';
		script2 += 'RPC_URL="${2:-https://api.mainnet-beta.solana.com}"\n\n';
		script2 += 'if [ -z "$KEYPAIR" ]; then\n';
		script2 += '    echo "Usage: bash $0 /path/to/keypair.json [rpc_url]"\n';
		script2 += '    exit 1\n';
		script2 += 'fi\n\n';
		script2 += 'echo "Using keypair: $KEYPAIR"\n';
		script2 += 'echo "Using RPC: $RPC_URL"\n';
		script2 += 'echo ""\n\n';

		for (const op of increaseOps) {
			const nameComment = op.name ? op.name : 'Unknown';
			const cleanAmount = toCleanSOL(op.amount);
			script2 += `echo "Increasing stake for: ${nameComment}"\n`;
			script2 += `echo "Vote Account: ${op.voteAccount}"\n`;
			script2 += `echo "Amount to add: ${cleanAmount} SOL"\n\n`;

			script2 += `spl-stake-pool increase-validator-stake ${POOL_ADDRESS} ${op.voteAccount} ${cleanAmount} \\\n`;
			script2 += `    --url "$RPC_URL" \\\n`;
			script2 += `    --manager "$KEYPAIR" \\\n`;
			script2 += `    --fee-payer "$KEYPAIR"\n\n`;

			script2 += `echo "----------------------------------------"\n\n`;
		}

		const file2 = `${folderName}/02_increase_stake.sh`;
		fs.writeFileSync(file2, script2, 'utf8');
		fs.chmodSync(file2, '755');
		console.log(colors.green + `  ✓ Generated ${file2} (${increaseOps.length} validators)` + colors.reset);
	} else {
		console.log(colors.dim + '  No increase operations needed' + colors.reset);
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
		currentPage: 1,
		validatorsPerPage: 15,
	};

	while (true) {
		clearScreen();
		printHeader(state);
		printValidatorList(state);
		printMenu();

		const input = await prompt('  > ');
		const parts = input.trim().split(/\s+/);
		const cmd = parts[0]?.toLowerCase();

		if (cmd === 'q') {
			console.log('  Goodbye!');
			rl.close();
			process.exit(0);
		} else if (cmd === 'n' || cmd === 'next') {
			const allValidators = [
				...state.validators,
				...state.newValidators,
			];
			const totalPages = Math.max(1, Math.ceil(allValidators.length / state.validatorsPerPage));
			if (state.currentPage < totalPages) {
				state.currentPage++;
			}
		} else if (cmd === 'p' || cmd === 'prev' || cmd === 'previous') {
			if (state.currentPage > 1) {
				state.currentPage--;
			}
		} else if (cmd === 'r' && parts[1]) {
			const idx = parseInt(parts[1], 10) - 1;
			const validator = state.validators[idx];
			if (idx >= 0 && idx < state.validators.length && validator) {
				validator.action = 'remove';
				validator.targetBalance = 0;
				normalizePage(state);
			} else {
				console.log(colors.red + '  Invalid validator number' + colors.reset);
				await prompt('  Press Enter to continue...');
			}
		} else if (cmd === 'u' && parts[1]) {
			const idx = parseInt(parts[1], 10) - 1;
			const validator = state.validators[idx];
			if (idx >= 0 && idx < state.validators.length && validator) {
				validator.action = 'keep';
				validator.targetBalance = validator.activeBalance;
				normalizePage(state);
			}
		} else if (cmd === 's' && parts[1] && parts[2]) {
			const idx = parseInt(parts[1], 10) - 1;
			const amount = parseFloat(parts[2]);
			const validator = state.validators[idx];
			if (idx >= 0 && idx < state.validators.length && !isNaN(amount) && validator) {
				validator.targetBalance = amount;
			} else if (
				idx >= state.validators.length &&
				idx < state.validators.length + state.newValidators.length
			) {
				const newIdx = idx - state.validators.length;
				const newValidator = state.newValidators[newIdx];
				if (newValidator) {
					newValidator.targetBalance = amount;
				}
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
				state.newValidators.push({
					voteAccount,
					stakeAccount: '',
					activeBalance: 0,
					activeBalanceLamports: '0',
					transientStakeAccount: '',
					transientBalance: 0,
					transientBalanceLamports: '0',
					targetBalance: 0,
					action: 'add',
				});
				normalizePage(state);
				console.log(colors.green + '  Added new validator. Set stake with: s # AMOUNT' + colors.reset);
				await prompt('  Press Enter to continue...');
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

