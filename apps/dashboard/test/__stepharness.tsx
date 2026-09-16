import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { NumberStepper } from '../src/components/ui/controls.tsx';

const root = join(import.meta.dir, '..', 'src', 'styles');
const css = ['tokens.css', 'base.css', 'controls.css', 'surfaces.css', 'rows.css']
  .map((f) => readFileSync(join(root, f), 'utf8'))
  .join('\n');

const cases: Array<[string, React.ReactElement]> = [
  ['default (width 116)', <NumberStepper label="Amount" value={20} onChange={() => undefined} />],
  [
    'at minimum — minus disabled',
    <NumberStepper label="Floor" value={0} min={0} max={10} onChange={() => undefined} />,
  ],
  [
    'at maximum — plus disabled',
    <NumberStepper label="Ceiling" value={10} min={0} max={10} onChange={() => undefined} />,
  ],
  [
    'with a unit',
    <NumberStepper label="Days" value={30} unit="days" width={150} onChange={() => undefined} />,
  ],
  ['invalid', <NumberStepper label="Bad" value={999} invalid onChange={() => undefined} />],
  ['disabled', <NumberStepper label="Off" value={5} disabled onChange={() => undefined} />],
  [
    'bitrate: six digits at width 132 (real call site)',
    <NumberStepper
      label="Bitrate"
      value={384000}
      min={8000}
      max={384000}
      step={1000}
      width={132}
      onChange={() => undefined}
    />,
  ],
  [
    'narrowest in use: width 96',
    <NumberStepper label="Narrow" value={100} width={96} onChange={() => undefined} />,
  ],
];

const body = cases
  .map(([label, el]) => `<h2>${label}</h2><div class="box">${renderToStaticMarkup(el)}</div>`)
  .join('\n');

writeFileSync(
  join(import.meta.dir, '..', 'public', '__step-check.html'),
  `<!doctype html><html><head><meta charset="utf-8"><title>Number stepper</title><style>${css}
body{background:#121216;color:#dbdee1;font-family:system-ui,sans-serif;padding:24px;margin:0}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#868e9f;margin:20px 0 6px}
.box{padding:10px 0}
</style></head><body>${body}</body></html>`,
  'utf8',
);

console.log('written');
