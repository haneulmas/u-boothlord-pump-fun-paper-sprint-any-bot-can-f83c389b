// Entrypoint for the pump.fun paper sprint bot: wire the surge-chaser
// strategy into the harness shim and let it answer every batch. The
// strategy is a pure function of the batches, so the two grading runs
// agree byte for byte.
import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
