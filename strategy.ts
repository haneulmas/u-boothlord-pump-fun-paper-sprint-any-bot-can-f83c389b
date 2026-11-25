// Surge-chaser for the 6-hour pump.fun paper sprint.
//
// Idea, in one paragraph: most new bonding curves fade within minutes, so
// this bot never buys a quiet coin. It watches the live trade tape of every
// mint, and only steps in when a coin is actively surging right now — price
// climbing across its recent trades, buyers outnumbering sellers, fresh SOL
// flowing in, and several distinct wallets buying. One flat 0.01 SOL stake
// per coin, at most five coins held at once. Once in, it banks half the
// position after a strong run, lets the rest ride behind a trailing peak,
// and cuts the whole thing on a hard drop or when the coin goes stale.
// A small number of looser "coverage" entries exists only to make sure the
// bot trades enough distinct coins to clear the 20-coin bar; they use spare
// capacity, never displace a strong signal.
//
// Pure function of the harness batches: no clock, no randomness, no I/O,
// no reads of anything outside the batch the harness just delivered.

import {
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
} from './vendor/agentfun-bot.ts';

export interface Params {
  stakeSol: number;
  tapeTrades: number;
  minTapeTrades: number;
  windowSlots: number;
  recentSlots: number;
  surgeRise: number;
  surgeRecentRise: number;
  surgeBuyShare: number;
  surgeInflowSol: number;
  surgeBuyers: number;
  coverRise: number;
  coverBuyShare: number;
  coverInflowSol: number;
  coverBuyers: number;
  maxCoverBuys: number;
  maxBuysPerCoin: number;
  rebuyCooldownSlots: number;
  bankAt: number;
  trailArm: number;
  trailGiveback: number;
  cutAt: number;
  staleAfterSlots: number;
  slippageBps: number;
  sellSlippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  stakeSol: 0.01,
  tapeTrades: 300,
  minTapeTrades: 200,
  windowSlots: 1000,
  recentSlots: 120,
  surgeRise: 0.3,
  surgeRecentRise: 0.05,
  surgeBuyShare: 0.6,
  surgeInflowSol: 2.0,
  surgeBuyers: 4,
  coverRise: 0.08,
  coverBuyShare: 0.55,
  coverInflowSol: 1.0,
  coverBuyers: 4,
  maxCoverBuys: 8,
  maxBuysPerCoin: 2,
  rebuyCooldownSlots: 600,
  bankAt: 0.6,
  trailArm: 0.2,
  trailGiveback: 0.2,
  cutAt: 0.2,
  staleAfterSlots: 400,
  slippageBps: 500,
  sellSlippageBps: 1000,
};

interface TapePrint {
  slot: number;
  price: number;
  buy: boolean;
  sol: number;
  wallet: string;
}

interface CoinTape {
  prints: TapePrint[];
  lastSlot: number;
}

interface OpenTrade {
  entryUnit: number;
  peakUnit: number;
  openedSlot: number;
  banked: boolean;
}

interface TapeStats {
  rise: number;
  recentRise: number;
  nearHigh: boolean;
  buyShare: number;
  inflowSol: number;
  buyers: number;
  prints: number;
}

const SOL_LAMPORTS = 1_000_000_000;

function curvePrice(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const tokens = Number(curve.virtual_token_reserves);
  if (tokens <= 0) return 0;
  return Number(curve.virtual_quote_reserves) / tokens;
}

// Windows are measured in slots, not in trade counts: forty trades on a
// quiet coin can span an hour, while forty trades on a hot coin span
// seconds, so a trade-count window compares incomparable things. A coin
// only counts as surging if it climbed inside a fixed slot window *and*
// traded often enough inside it to prove the move is live.
function tapeStats(tape: CoinTape, nowSlot: number, windowSlots: number, recentSlots: number): TapeStats {
  const prints = tape.prints.filter((p) => p.slot > nowSlot - windowSlots);
  if (prints.length === 0) {
    return { rise: 0, recentRise: 0, nearHigh: false, buyShare: 0, inflowSol: 0, buyers: 0, prints: 0 };
  }
  const first = prints[0]!;
  const last = prints[prints.length - 1]!;
  let buys = 0;
  let inflow = 0;
  let high = 0;
  const wallets = new Set<string>();
  for (const p of prints) {
    if (p.price > high) high = p.price;
    if (p.buy) {
      buys += 1;
      inflow += p.sol;
      wallets.add(p.wallet);
    } else {
      inflow -= p.sol;
    }
  }
  const recent = prints.filter((p) => p.slot > nowSlot - recentSlots);
  const recentFirst = recent[0];
  return {
    rise: first.price > 0 ? last.price / first.price - 1 : 0,
    recentRise: recentFirst !== undefined && recentFirst.price > 0 ? last.price / recentFirst.price - 1 : 0,
    nearHigh: high > 0 && last.price >= high * 0.98,
    buyShare: prints.length > 0 ? buys / prints.length : 0,
    inflowSol: inflow,
    buyers: wallets.size,
    prints: prints.length,
  };
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<string, CoinTape>();
  const book = new Map<string, OpenTrade>();
  const boughtCoins = new Set<string>();
  const buysPerCoin = new Map<string, number>();
  const lastSoldSlot = new Map<string, number>();
  let coverBuys = 0;

  function noteFills(batch: Batch, state: BotState): void {
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || fill.side !== 'buy') continue;
      boughtCoins.add(fill.mint);
      buysPerCoin.set(fill.mint, (buysPerCoin.get(fill.mint) ?? 0) + 1);
      if (book.has(fill.mint)) continue;
      const tokens = Number(fill.token_amount);
      const paid = Number(fill.quote_lamports);
      const unit = tokens > 0 ? paid / tokens : 0;
      book.set(fill.mint, {
        entryUnit: unit,
        peakUnit: unit,
        openedSlot: fill.slot,
        banked: false,
      });
    }
    // Positions the harness flattened or migrated are gone from the
    // account; drop their bookkeeping so a later re-entry starts clean.
    for (const mint of [...book.keys()]) {
      if (!state.positions.has(mint)) book.delete(mint);
    }
  }

  function noteEvents(batch: Batch): string[] {
    const touched: string[] = [];
    const seen = new Set<string>();
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        if (!tapes.has(event.mint)) {
          tapes.set(event.mint, { prints: [], lastSlot: event.slot });
        }
        continue;
      }
      if (event.event !== 'TradeEvent') continue;
      let tape = tapes.get(event.mint);
      if (tape === undefined) {
        tape = { prints: [], lastSlot: event.slot };
        tapes.set(event.mint, tape);
      }
      const tokenReserves = Number(event.virtual_token_reserves);
      const price = tokenReserves > 0 ? Number(event.virtual_quote_reserves) / tokenReserves : 0;
      tape.prints.push({
        slot: event.slot,
        price,
        buy: event.is_buy,
        sol: Number(event.sol_amount) / SOL_LAMPORTS,
        wallet: event.user,
      });
      if (tape.prints.length > params.tapeTrades) {
        tape.prints.splice(0, tape.prints.length - params.tapeTrades);
      }
      tape.lastSlot = event.slot;
      if (!seen.has(event.mint)) {
        seen.add(event.mint);
        touched.push(event.mint);
      }
    }
    return touched;
  }

  function pruneTapes(state: BotState, slot: number): void {
    if (tapes.size <= 3000) return;
    const stale: string[] = [];
    for (const [mint, tape] of tapes) {
      if (state.positions.has(mint)) continue;
      if (slot - tape.lastSlot > 20000) stale.push(mint);
    }
    stale.sort((a, b) => tapes.get(a)!.lastSlot - tapes.get(b)!.lastSlot);
    for (const mint of stale.slice(0, tapes.size - 3000)) tapes.delete(mint);
  }

  function exitOrders(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    // Tokens already promised to a sell still in flight are not ours to
    // sell again: the account only shrinks once the fill lands, so without
    // this the same tokens get sold twice and the second order is refused.
    const promised = new Map<string, bigint>();
    for (const p of state.pending.values()) {
      if (p.order.side !== 'sell') continue;
      promised.set(p.order.mint, (promised.get(p.order.mint) ?? 0n) + BigInt(p.order.token_amount));
    }
    for (const [mint, holding] of state.positions) {
      let trade = book.get(mint);
      if (trade === undefined) {
        // Fill arrived before this session tracked it: rebuild the entry
        // from the position's own cost basis.
        const unit = holding.token_amount > 0n
          ? Number(holding.cost_lamports) / Number(holding.token_amount)
          : 0;
        trade = { entryUnit: unit, peakUnit: unit, openedSlot: batch.slot, banked: false };
        book.set(mint, trade);
      }
      const price = curvePrice(state, mint);
      if (price <= 0 || trade.entryUnit <= 0) continue;
      if (price > trade.peakUnit) trade.peakUnit = price;
      const gain = price / trade.entryUnit - 1;
      const age = batch.slot - trade.openedSlot;
      // Only the tokens not already promised to an in-flight sell can be
      // offered again; a partial bank leaves the rest for the trail.
      const tokens = holding.token_amount - (promised.get(mint) ?? 0n);
      if (tokens <= 0n) continue;
      if (gain <= -params.cutAt || age >= params.staleAfterSlots) {
        lastSoldSlot.set(mint, batch.slot);
        orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: params.sellSlippageBps });
        continue;
      }
      if (!trade.banked && gain >= params.bankAt) {
        const half = tokens / 2n;
        if (half > 0n) {
          trade.banked = true;
          orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: params.sellSlippageBps });
        }
        continue;
      }
      if (gain >= params.trailArm && price <= trade.peakUnit * (1 - params.trailGiveback)) {
        lastSoldSlot.set(mint, batch.slot);
        orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: params.sellSlippageBps });
      }
    }
    return orders;
  }

  function entryOrders(state: BotState, touched: string[], exiting: Set<string>, batchSlot: number): OrderInput[] {
    const orders: OrderInput[] = [];
    const stake = BigInt(Math.round(params.stakeSol * SOL_LAMPORTS));
    // Pending orders are keyed by client id, so collect their mints first:
    // a coin with a buy already in flight must not get a second one.
    const inFlight = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') inFlight.add(p.order.mint);
    }
    for (const mint of touched) {
      if (state.positions.has(mint)) continue;
      if (exiting.has(mint)) continue;
      if (inFlight.has(mint)) continue;
      // A coin just sold is cooling off: re-buying the same fade is how
      // churn happens. Same for coins already bought twice.
      const cooled = lastSoldSlot.get(mint);
      if (cooled !== undefined && batchSlot - cooled < params.rebuyCooldownSlots) continue;
      if ((buysPerCoin.get(mint) ?? 0) >= params.maxBuysPerCoin) continue;
      if (state.committedPositionCount() + orders.length >= state.hello.caps.max_open_positions) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (state.maxBuyLamports(mint) < stake) continue;
      const tape = tapes.get(mint);
      if (tape === undefined) continue;
      const stats = tapeStats(tape, batchSlot, params.windowSlots, params.recentSlots);
      if (stats.prints < params.minTapeTrades) continue;
      const strong =
        stats.rise >= params.surgeRise &&
        stats.recentRise >= params.surgeRecentRise &&
        stats.nearHigh &&
        stats.buyShare >= params.surgeBuyShare &&
        stats.inflowSol >= params.surgeInflowSol &&
        stats.buyers >= params.surgeBuyers;
      let cover = false;
      if (!strong && boughtCoins.size < 20 && coverBuys < params.maxCoverBuys) {
        // Spare-capacity coverage only: never take a slot a strong
        // signal could use, and stop once the bar is comfortably met.
        const spare = state.committedPositionCount() + orders.length <= 2;
        cover =
          spare &&
          stats.nearHigh &&
          stats.rise >= params.coverRise &&
          stats.buyShare >= params.coverBuyShare &&
          stats.inflowSol >= params.coverInflowSol &&
          stats.buyers >= params.coverBuyers;
      }
      if (!strong && !cover) continue;
      if (state.freeCashLamports() < stake + state.txFeeLamports() * 2n) break;
      if (cover) coverBuys += 1;
      orders.push({ side: 'buy', mint, quote_lamports: stake, max_slippage_bps: params.slippageBps });
    }
    return orders;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      noteFills(batch, state);
      const touched = noteEvents(batch);
      const exits = exitOrders(state, batch);
      const exiting = new Set(exits.map((o) => o.mint));
      const entries = entryOrders(state, touched, exiting, batch.slot);
      pruneTapes(state, batch.slot);
      return [...exits, ...entries];
    },
  };
}
