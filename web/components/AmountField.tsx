'use client'

import { parseUnits } from 'viem'

/** Six decimal usdg as `$1,234.50`, trimmed of a trailing `.00`. */
export function money(v: bigint): string {
  const n = Number(v) / 1e6
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 2 })}`
}

/** What the user typed, as usdg, or zero if it is not a number yet. */
export function toUsdg(text: string): bigint {
  try {
    return parseUnits(text || '0', 6)
  } catch {
    return 0n
  }
}

export type Limit = { max: bigint; why: string }

/**
 * The binding ceiling, and why. Null when nothing is known to bind.
 *
 * @remarks
 * There are three separate ways an amount somebody types is too big, and they
 * are not interchangeable: the router's own per transaction cap, what the
 * wallet actually holds, and, on a basket token, the size of the raise itself.
 * Whichever is smallest is the one that will stop the transaction, so that is
 * the one worth naming. An unknown limit is left out rather than treated as
 * zero, because a read that did not come back is not a ceiling of nothing.
 */
export function binding(limits: (Limit | null)[]): Limit | null {
  let out: Limit | null = null
  for (const l of limits) {
    if (!l || l.max <= 0n) continue
    if (out === null || l.max < out.max) out = l
  }
  return out
}

/**
 * An amount somebody types, with quick fills under it.
 *
 * @remarks
 * This was four preset buttons and a text input, all in one row, so the input
 * read as a fifth preset and was reported as "it only offers none, 50, 100 and
 * 500" by somebody looking straight at the box they could have typed in. A
 * control nobody can see is a control that does not exist, and no amount of it
 * working correctly changes that.
 *
 * The presets are gone entirely rather than moved below the field. Any list of
 * them is a guess at what somebody has to spend, and the one thing asked for
 * here was that they type their own number. A row of chips under the field
 * still puts four guesses in front of the answer.
 *
 * What replaces them is the ceiling, which is the only thing the form actually
 * knows that the person typing does not.
 *
 * Shared by both launch forms rather than copied into each, which is how two of
 * them drift: one gets a ceiling and the other does not, and nothing says so.
 */
export function AmountField({
  value,
  onChange,
  limit,
  label,
  help,
}: {
  value: string
  onChange: (v: string) => void
  limit: Limit | null
  label: string
  help: React.ReactNode
}) {
  const wanted = toUsdg(value)
  const over = limit !== null && wanted > limit.max

  return (
    <div style={{ marginTop: 24 }}>
      <label>{label}</label>
      <div className={`amountbox${over ? ' bad' : ''}`}>
        <span className="amountbox-c num">$</span>
        <input
          className="amountbox-in num"
          value={value}
          // Digits and one dot, capped at a length no real amount reaches, so a
          // pasted address or a leaned-on key cannot become a number at all.
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, '').slice(0, 12))}
          inputMode="decimal"
          placeholder="0"
          aria-label={label}
        />
        <span className="amountbox-c num dim">USDG</span>
      </div>

      <div className="dim small" style={{ marginTop: 10, lineHeight: 1.6 }}>
        {help}
        {limit !== null && (
          <>
            {' '}
            The most this transaction can take is <b className="num">{money(limit.max)}</b>, {limit.why}.
          </>
        )}
      </div>

      {over && limit !== null && (
        <div className="notice bad" style={{ marginTop: 10 }}>
          <b>{money(wanted)} is over the limit.</b> {money(limit.max)} is the most that can go
          through here, {limit.why}. Sent as it is this would be refused on chain, after the
          approval had already been signed.
        </div>
      )}
    </div>
  )
}
