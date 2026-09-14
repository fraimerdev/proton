import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NumberStepper } from '../src/components/ui/controls.tsx';

function inputModeOf(step: number | undefined): string | undefined {
  const markup = renderToStaticMarkup(
    <NumberStepper label="Amount" value={1} step={step} onChange={() => undefined} />,
  );

  return /inputmode="([a-z]+)"/i.exec(markup)?.[1];
}

describe('NumberStepper', () => {
  test('asks for a keypad with a decimal point when the step is fractional', () => {
    expect(inputModeOf(0.1)).toBe('decimal');
  });

  test('keeps the digits-only keypad for whole steps', () => {
    expect(inputModeOf(1)).toBe('numeric');
    expect(inputModeOf(undefined)).toBe('numeric');
  });
});
