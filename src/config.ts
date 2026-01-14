import { Connection, PublicKey } from '@solana/web3.js';

// Stake Pool Address (can override with POOL_ADDRESS env var)
if (!process.env.POOL_ADDRESS) {
	throw new Error(
		'POOL_ADDRESS environment variable is not set. Please add POOL_ADDRESS to your .env file.\n' +
		'Example: POOL_ADDRESS=DpooSqZRL3qCmiq82YyB4zWmLfH3iEqx2gy8f2B6zjru',
	);
}

export const POOL_ADDRESS = new PublicKey(process.env.POOL_ADDRESS);

export const connection = new Connection(
	process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
	'confirmed',
);
