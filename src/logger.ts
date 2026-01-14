type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

const CURRENT_LEVEL: LogLevel =
	(process.env.LOG_LEVEL as LogLevel) || 'info';

function log(
	level: LogLevel,
	msg: string,
	meta?: Record<string, unknown>,
) {
	if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[CURRENT_LEVEL]) return;
	const time = new Date().toISOString();
	const base = { level, time, msg };
	// Avoid noisy undefined values
	const withMeta = meta ? { ...base, ...meta } : base;
	// eslint-disable-next-line no-console
	console.log(JSON.stringify(withMeta));
}

export const logger = {
	debug: (m: string, meta?: Record<string, unknown>) => log('debug', m, meta),
	info: (m: string, meta?: Record<string, unknown>) => log('info', m, meta),
	warn: (m: string, meta?: Record<string, unknown>) => log('warn', m, meta),
	error: (m: string, meta?: Record<string, unknown>) => log('error', m, meta),
};
