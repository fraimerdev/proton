import type { RoleReward } from '@proton/module-leveling/config';
import { MAX_LEVEL, xpForLevel } from '@proton/module-leveling/curve';
import type { ReactElement } from 'react';
import type { DiscordRole } from '../form/picker.tsx';

export interface XpCurveProps {
  rewards: readonly RoleReward[];
  roles: readonly DiscordRole[];
  xpMin: number;
  xpMax: number;
}

const W = 760;
const H = 226;

const PAD_LEFT = 58;
const PAD_RIGHT = 16;
const PAD_TOP = 14;
const PAD_BOTTOM = 30;

const PLOT_W = W - PAD_LEFT - PAD_RIGHT;
const PLOT_H = H - PAD_TOP - PAD_BOTTOM;

const FLOOR_LEVELS = 20;
const HEADROOM = 5;
const SAMPLES = 120;

// Hand-rolled rather than toLocaleString: the server renders this string and the browser renders it
// again, and a locale-formatted number differs between the two as a hydration mismatch.
function group(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function compact(xp: number): string {
  if (xp >= 1_000_000) return `${Math.round(xp / 100_000) / 10}m`;
  if (xp >= 1_000) return `${Math.round(xp / 100) / 10}k`;

  return String(xp);
}

function roleName(roles: readonly DiscordRole[], roleId: string): string {
  if (roleId === '') return 'no role chosen';

  return roles.find((role) => role.id === roleId)?.name ?? roleId;
}

function messagesFor(level: number, xpMin: number, xpMax: number): number | null {
  const average = (xpMin + xpMax) / 2;
  if (!Number.isFinite(average) || average <= 0) return null;

  return Math.ceil(xpForLevel(level) / average);
}

export function XpCurve({ rewards, roles, xpMin, xpMax }: XpCurveProps): ReactElement {
  const highest = rewards.reduce((top, reward) => Math.max(top, reward.level), 0);
  const span = Math.min(MAX_LEVEL, Math.max(FLOOR_LEVELS, highest + HEADROOM));
  const maxXp = xpForLevel(span);

  const x = (level: number): number => PAD_LEFT + (level / span) * PLOT_W;
  const y = (xp: number): number => PAD_TOP + PLOT_H - (xp / maxXp) * PLOT_H;

  const step = Math.max(1, Math.ceil(span / SAMPLES));
  const levels: number[] = [];
  for (let level = 0; level < span; level += step) levels.push(level);
  levels.push(span);

  const line = levels
    .map((level) => {
      const point = `${x(level).toFixed(1)} ${y(xpForLevel(level)).toFixed(1)}`;
      return `${level === 0 ? 'M' : 'L'}${point}`;
    })
    .join(' ');

  const fill = `${line} L${x(span).toFixed(1)} ${y(0)} L${x(0)} ${y(0)} Z`;

  const marked = rewards
    .map((reward, index) => ({ ...reward, at: index }))
    .filter((reward) => reward.level > 0 && reward.level <= span)
    .sort((first, second) => first.level - second.level);

  const toSecond = messagesFor(2, xpMin, xpMax);
  const reach = highest > 0 ? highest : 10;
  const toReach = messagesFor(reach, xpMin, xpMax);

  return (
    <div className="curve">
      <svg
        className="curve-plot"
        role="img"
        viewBox={`0 0 ${W} ${H}`}
        aria-label={
          `Total XP against level, from level 0 to ${span}. ` +
          `Level ${span} costs ${group(maxXp)} XP in total.`
        }
      >
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
          <g key={fraction}>
            <line
              className="curve-grid"
              x1={PAD_LEFT}
              x2={W - PAD_RIGHT}
              y1={y(maxXp * fraction)}
              y2={y(maxXp * fraction)}
            />
            <text className="curve-tick" x={PAD_LEFT - 10} y={y(maxXp * fraction) + 4}>
              {compact(maxXp * fraction)}
            </text>
          </g>
        ))}

        <path className="curve-fill" d={fill} />
        <path className="curve-line" d={line} />

        {marked.map((reward) => (
          <g key={reward.at}>
            <line
              className="curve-flag"
              x1={x(reward.level)}
              x2={x(reward.level)}
              y1={y(xpForLevel(reward.level))}
              y2={y(0)}
            />
            <circle
              className="curve-dot"
              cx={x(reward.level)}
              cy={y(xpForLevel(reward.level))}
              r={4}
            />
          </g>
        ))}

        <line className="curve-axis" x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={y(0)} y2={y(0)} />

        <text className="curve-tick curve-tick-x" x={PAD_LEFT} y={H - 10}>
          Level 0
        </text>
        <text className="curve-tick curve-tick-x curve-tick-end" x={W - PAD_RIGHT} y={H - 10}>
          {span}
        </text>
      </svg>

      <p className="curve-readout">
        {toSecond === null || toReach === null ? (
          'Messages earn no XP at these numbers, so the curve is unreachable by chatting.'
        ) : (
          <>
            At {xpMin}–{xpMax} XP a message, level 2 takes about {group(toSecond)} messages and
            level {reach} about {group(toReach)}.
          </>
        )}
      </p>

      {marked.length === 0 ? (
        <p className="field-empty">
          No rewards on the curve. Members still gain XP and appear on the leaderboard; no roles are
          granted.
        </p>
      ) : (
        <ul className="curve-legend">
          {marked.map((reward) => (
            <li key={reward.at}>
              <span className="curve-legend-level">Level {reward.level}</span>
              <span className="curve-legend-role">{roleName(roles, reward.roleId)}</span>
              <span className="curve-legend-xp">{group(xpForLevel(reward.level))} XP</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
