// ---------------------------------------------------------------------------
// PER-AGENT ONLINE LEARNING: a linear contextual bandit, cheap enough for
// thousands of agents. Each agent keeps a small weight vector θ_action
// (lazily allocated, bounded) per action it has actually tried:
//
//     Q(action | context) = θ_action · context
//     θ_action += lr * (reward − Q) * context      (only the taken action)
//
// The decision loop combines Q with the existing utility scores, so learning
// nudges behaviour rather than replacing the hand-tuned survival AI.
// Social learning copies small fractions of θ between trusted agents;
// children absorb their caretaker's weights by observation. No cloud, no LLM,
// fully deterministic (all randomness flows from sim.rand).
// ---------------------------------------------------------------------------
import { clamp } from './rng.js';
import { tileIndex } from './world.js';
import { lifeStageOf } from './lifecycle.js';

export const CTX_DIM = 14;
const LR = 0.08;           // bandit learning rate
const W_CLAMP = 2.0;       // per-weight bound (prevents runaway behaviour)
export const Q_WEIGHT = 0.55; // how strongly learning sways the utility AI

const STAGE_NUM = { infant: 0, child: 0.2, adolescent: 0.45, adult: 0.75, elder: 1 };

/**
 * Fill a reusable Float32Array with the agent's decision context.
 * [bias, hunger, thirst, tired, fear, health, localFood, localWater,
 *  danger, fertility, homeStability, crowding, lifeStage, kidsNearby]
 */
export function buildContext(sim, a, out) {
  const w = sim.world;
  const ti = tileIndex(w, a.x, a.y);
  const home = a.home >= 0 ? sim.settlementById.get(a.home) : null;
  out[0] = 1;
  out[1] = a.hunger / 100;
  out[2] = a.thirst / 100;
  out[3] = 1 - a.energy / 100;
  out[4] = a.fear / 100;
  out[5] = a.health / 100;
  out[6] = Math.min(1, w.food[ti] / 80);
  out[7] = w.water[ti] / 100;
  out[8] = w.danger[ti];
  out[9] = w.fertility[ti];
  out[10] = home ? home.stability : 0.3;
  out[11] = home ? Math.min(1, home.members / Math.max(8, home.infraCap || 30)) : 0;
  out[12] = STAGE_NUM[a.lifeStage] ?? 0.75;
  out[13] = a.hasYoungKids ? 1 : 0;
  return out;
}

function theta(a, action) {
  let t = a.theta[action];
  if (!t) t = a.theta[action] = new Float32Array(CTX_DIM);
  return t;
}

/** Learned preference for an action in this context (0 if never learned). */
export function qValue(a, action, ctx) {
  const t = a.theta[action];
  if (!t) return 0;
  let q = 0;
  for (let i = 0; i < CTX_DIM; i++) q += t[i] * ctx[i];
  return q;
}

/** Decaying exploration bonus: curious young agents try more things. */
export function explorationRate(a) {
  return 0.3 * a.curiosity / (1 + (a.expCount || 0) * 0.004);
}

/**
 * Reward the agent's last decision. Positive = do this more in this context.
 * Called only on discrete outcome events (harvest, trade, injury, birth...),
 * never per-frame — cheap and interpretable.
 */
export function learnReward(sim, a, action, reward) {
  if (sim.params.enableLearning === false) return;
  const ctx = a.lastCtx;
  if (!ctx) return;
  const t = theta(a, action);
  let pred = 0;
  for (let i = 0; i < CTX_DIM; i++) pred += t[i] * ctx[i];
  const err = clamp(reward - pred, -3, 3);
  for (let i = 0; i < CTX_DIM; i++) {
    t[i] = clamp(t[i] + LR * err * ctx[i], -W_CLAMP, W_CLAMP);
  }
  a.expCount = (a.expCount || 0) + 1;
  a.rewardEMA = (a.rewardEMA || 0) * 0.92 + reward * 0.08;
  a.rewards.push({ a: action, r: Math.round(reward * 100) / 100 });
  if (a.rewards.length > 6) a.rewards.shift();
  sim.totals.rewardSum += reward;
  sim.totals.rewardCount++;
}

/**
 * Social learning: the learner blends a fraction of a more successful
 * agent's weights into its own. transfer ∝ trust × sociability × success.
 */
export function socialTransfer(sim, learner, teacher, baseK = 0.08) {
  if (sim.params.enableSocialLearning === false) return;
  if ((teacher.rewardEMA || 0) <= (learner.rewardEMA || 0)) return; // learn upward only
  const trust = Math.max(0, learner.rel.get(teacher.id) || 0.2);
  const elderBoost = teacher.lifeStage === 'elder' ? 1.5 : 1; // elders teach
  const k = clamp(baseK * trust * (0.5 + learner.sociability) * elderBoost, 0, 0.2);
  if (k <= 0.005) return;
  const actions = Object.keys(teacher.theta);
  if (!actions.length) return;
  // copy at most two of the teacher's learned behaviours (bounded work)
  for (let n = 0; n < 2 && n < actions.length; n++) {
    const act = actions[(sim.rand() * actions.length) | 0];
    const src = teacher.theta[act];
    const dst = theta(learner, act);
    for (let i = 0; i < CTX_DIM; i++) {
      dst[i] = clamp(dst[i] * (1 - k) + src[i] * k, -W_CLAMP, W_CLAMP);
    }
  }
  learner.learnedFrom = `${teacher.firstName} ${teacher.lastName}`;
}

/** Top learned behaviours for the inspector (small, built on demand). */
export function topLearned(a, ctx, n = 3) {
  const rows = [];
  for (const act of Object.keys(a.theta)) rows.push([act, qValue(a, act, ctx)]);
  rows.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
  return rows.slice(0, n).map(([act, q]) => `${act} ${q >= 0 ? '+' : ''}${q.toFixed(2)}`);
}

export { lifeStageOf };
