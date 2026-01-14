import fs from 'fs';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
	getStakePoolAccount,
	ValidatorListLayout,
	type ValidatorList,
} from '@solana/spl-stake-pool';
import {
	connection,
	POOL_ADDRESS,
} from './config.ts';
import { logger } from './logger.ts';

// Stake Pool Program ID
const STAKE_POOL_PROGRAM_ID = new PublicKey(
	'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy',
);

export interface PoolValidatorData {
	voteAccount: string;
	name: string | null;
	stakeAccount: string;
	activeBalance: number;
	transientStakeAccount: string;
	transientBalance: number;
}

export interface PoolData {
	reserveAccount: string;
	reserveBalance: number;
	validators: PoolValidatorData[];
}

const RUGALERT_API_BASE = 'https://rugalert.pumpkinspool.com/api/meta';

interface RugAlertMeta {
	meta: {
		name?: string;
		avatarUrl?: string;
		website?: string;
		description?: string;
	};
}

async function fetchValidatorName(voteAccount: string): Promise<string | null> {
	try {
		const response = await fetch(`${RUGALERT_API_BASE}/${voteAccount}`);
		if (!response.ok) {
			return null;
		}
		const data = (await response.json()) as RugAlertMeta;
		return data.meta?.name ?? null;
	} catch (error) {
		logger.debug('Failed to fetch validator name', { voteAccount, error });
		return null;
	}
}

function deriveStakeAccountPDA(voteAccountPk: PublicKey, seed?: number): PublicKey {
	const seeds = [
		voteAccountPk.toBuffer(),
		POOL_ADDRESS.toBuffer(),
	];

	if (seed !== undefined) {
		const seedBuffer = Buffer.alloc(4);
		seedBuffer.writeUInt32LE(seed);
		seeds.push(seedBuffer);
	}

	const [pubkey] = PublicKey.findProgramAddressSync(seeds, STAKE_POOL_PROGRAM_ID);
	return pubkey;
}

function deriveTransientStakeAccountPDA(
	voteAccountPk: PublicKey,
	transientSeed: bigint,
): PublicKey {
	const seedBuffer = Buffer.alloc(8);
	seedBuffer.writeBigUInt64LE(transientSeed);

	const [pubkey] = PublicKey.findProgramAddressSync(
		[
			Buffer.from('transient'),
			voteAccountPk.toBuffer(),
			POOL_ADDRESS.toBuffer(),
			seedBuffer,
		],
		STAKE_POOL_PROGRAM_ID,
	);
	return pubkey;
}

export async function dumpPoolValidatorData(outputPath: string = 'data.json'): Promise<PoolData> {
	logger.info('Starting dumpPoolValidatorData - fetching from RPC');

	logger.info('Fetching stake pool account from chain');
	const stakePool = await getStakePoolAccount(connection, POOL_ADDRESS);

	// Fetch reserve account balance
	const reserveStakeAccount = stakePool.account.data.reserveStake;
	const reserveBalanceLamports = await connection.getBalance(reserveStakeAccount);
	const reserveBalance = reserveBalanceLamports / LAMPORTS_PER_SOL;

	logger.info('Fetched reserve account balance', {
		reserveAccount: reserveStakeAccount.toBase58(),
		reserveBalance,
	});

	const validatorListInfo = await connection.getAccountInfo(
		stakePool.account.data.validatorList,
	);

	if (!validatorListInfo) {
		throw new Error('ValidatorList account not found on chain');
	}

	const validatorList = ValidatorListLayout.decode(
		validatorListInfo.data,
	) as ValidatorList;

	logger.info('Decoded validator list from chain', {
		totalValidators: validatorList.validators.length,
	});

	// First pass: collect all validator data without names
	const validatorsWithStake: Array<{
		voteAccount: string;
		stakeAccount: string;
		activeBalance: number;
		transientStakeAccount: string;
		transientBalance: number;
	}> = [];

	for (const validator of validatorList.validators) {
		const voteAccountPk = validator.voteAccountAddress;
		const voteAccount = voteAccountPk.toBase58();

		const activeStakeLamports = BigInt(validator.activeStakeLamports.toString());
		const transientStakeLamports = BigInt(validator.transientStakeLamports.toString());

		if (activeStakeLamports === 0n && transientStakeLamports === 0n) {
			continue;
		}

		const stakeAccountPk = deriveStakeAccountPDA(voteAccountPk);

		const transientSeed = BigInt(validator.transientSeedSuffixStart.toString());
		const transientStakeAccountPk = deriveTransientStakeAccountPDA(
			voteAccountPk,
			transientSeed,
		);

		validatorsWithStake.push({
			voteAccount,
			stakeAccount: stakeAccountPk.toBase58(),
			activeBalance: Number(activeStakeLamports) / LAMPORTS_PER_SOL,
			transientStakeAccount: transientStakeAccountPk.toBase58(),
			transientBalance: Number(transientStakeLamports) / LAMPORTS_PER_SOL,
		});
	}

	// Fetch all validator names in parallel
	logger.info('Fetching validator names in parallel', {
		count: validatorsWithStake.length,
	});

	const names = await Promise.all(
		validatorsWithStake.map((v) => fetchValidatorName(v.voteAccount))
	);

	// Merge names into results
	const results: PoolValidatorData[] = validatorsWithStake.map((v, i) => ({
		...v,
		name: names[i] ?? null,
	}));

	for (const data of results) {
		logger.debug('Processed validator', {
			voteAccount: data.voteAccount,
			name: data.name,
			stakeAccount: data.stakeAccount,
			activeBalance: data.activeBalance,
			transientBalance: data.transientBalance,
		});
	}

	logger.info('Processed all validators', {
		totalWithStake: results.length,
	});

	const jsonSafeResults = results.map((r) => ({
		voteAccount: r.voteAccount,
		name: r.name,
		stakeAccount: r.stakeAccount,
		activeBalance: r.activeBalance,
		transientStakeAccount: r.transientStakeAccount,
		transientBalance: r.transientBalance,
	}));

	const poolData: PoolData = {
		reserveAccount: reserveStakeAccount.toBase58(),
		reserveBalance,
		validators: jsonSafeResults,
	};

	fs.writeFileSync(outputPath, JSON.stringify(poolData, null, 2), 'utf8');

	logger.info('Dumped pool validator data to JSON', {
		outputPath,
		validatorCount: results.length,
		reserveBalance,
	});

	return poolData;
}
