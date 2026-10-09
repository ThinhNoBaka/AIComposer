import { useMemo, useRef, useState } from 'react'
import { TONE_LABEL, rhymeScheme, rhymeSuggestions, type Alignment, type LyricLine, type ToneHint } from '../core/lyrics'

type Props = {
  text: string
  lines: LyricLine[]
  alignment: Alignment
  hasMelody: boolean
  onText: (text: string) => void
  onMelodyFromLyrics: () => void
  onSplitNotes: () => void
  onFixHint: (hint: ToneHint) => void
  onSeekLine: (step: number) => void
  onDownload: () => void
}

const EXAMPLE = `[Đoạn 1]
Chiều nay mưa rơi trên phố
Em đi qua con đường xưa
[Điệp khúc]
Nhớ em nhiều lắm em ơi
Mưa ơi đừng rơi nữa`

export function LyricsPanel({ text, lines, alignment, hasMelody, onText, onMelodyFromLyrics, onSplitNotes, onFixHint, onSeekLine, onDownload }: Props) {
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const [rhymeWord, setRhymeWord] = useState('')
  const scheme = useMemo(() => rhymeScheme(lines), [lines])
  // Mặc định tìm vần cho chữ cuối của câu áp chót (câu đang viết thường cần vần với câu trước nó).
  const autoWord = scheme.at(-2)?.word ?? scheme.at(-1)?.word ?? ''
  const target = rhymeWord.trim() || autoWord
  const suggestions = useMemo(() => (target ? rhymeSuggestions(target) : []), [target])
  const short = alignment.lines.filter((l) => l.notes > 0 && l.line.syllables.length > l.notes)
  const missing = alignment.lines.filter((l) => l.notes === 0).length

  const insert = (word: string) => {
    const el = areaRef.current
    if (!el) return onText(text + word)
    const at = el.selectionEnd ?? text.length
    const before = text.slice(0, at)
    const sep = before && !/\s$/.test(before) ? ' ' : ''
    const next = before + sep + word + text.slice(at)
    onText(next)
    requestAnimationFrame(() => {
      el.focus()
      const pos = at + sep.length + word.length
      el.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className="lyrics">
      <p className="hint">Mỗi dòng là một câu hát. Dòng trong ngoặc vuông như [Điệp khúc] là nhãn, không hát. Chữ sẽ hiện trên từng nốt ở timeline.</p>
      <textarea
        ref={areaRef}
        className="lyrics-text"
        value={text}
        onChange={(e) => onText(e.target.value)}
        placeholder={EXAMPLE}
        rows={9}
        spellCheck={false}
        aria-label="Lời bài hát"
      />
      <div className="row wrap">
        <button className="btn btn-primary" onClick={onMelodyFromLyrics} disabled={!lines.length} title="Viết giai điệu mới đi theo thanh điệu của lời, thay giai điệu đang có">
          Viết giai điệu theo lời
        </button>
        <button className="btn" onClick={onSplitNotes} disabled={!short.length} title="Chẻ đôi nốt dài ở các câu thiếu nốt">
          Chia nốt cho đủ chữ
        </button>
        <button className="btn btn-quiet" onClick={onDownload} disabled={!lines.length}>
          Tải lời
        </button>
      </div>

      {lines.length > 0 && (
        <>
          <h3 className="side-h">Từng câu</h3>
          <ol className="lyric-lines">
            {alignment.lines.map(({ line, notes, start }) => {
              const r = scheme[line.index]
              const n = line.syllables.length
              const state = notes === 0 ? 'none' : n > notes ? 'short' : n < notes ? 'long' : 'ok'
              return (
                <li key={line.index} className={`lyric-line is-${state}`}>
                  <button className="lyric-go" onClick={() => start !== undefined && onSeekLine(start)} disabled={start === undefined} title="Phát từ câu này">
                    <span className="lyric-no">{line.index + 1}</span>
                    <span className="lyric-body">
                      {line.label && <span className="lyric-label">{line.label}</span>}
                      <span className="lyric-say">{line.text}</span>
                      <span className="lyric-meta">
                        {state === 'none' && 'Chưa có câu nhạc cho câu này'}
                        {state === 'ok' && `${n} chữ, ${notes} nốt, vừa khớp`}
                        {state === 'short' && `${n} chữ nhưng chỉ ${notes} nốt: thiếu ${n - notes} nốt`}
                        {state === 'long' && `${n} chữ, ${notes} nốt: chữ cuối ngân qua ${notes - n + 1} nốt`}
                        {r?.rhyme && (
                          <>
                            {' · vần '}
                            <b>{r.rhyme}</b> ({r.bang ? 'bằng' : 'trắc'}){r.group && <span className="rhyme-tag">{r.group}</span>}
                          </>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
          {(missing > 0 || alignment.freePhrases > 0) && (
            <p className="hint">
              {missing > 0 && `${missing} câu cuối chưa có nhạc: ngân thêm đoạn, viết thêm nốt, hoặc bấm Viết giai điệu theo lời. `}
              {alignment.freePhrases > 0 && `Còn ${alignment.freePhrases} câu nhạc chưa có lời.`}
            </p>
          )}
          {!hasMelody && <p className="hint">Chưa có giai điệu. Bấm Viết giai điệu theo lời để máy viết nhạc theo thanh điệu của từng chữ.</p>}

          <h3 className="side-h">Thanh điệu</h3>
          {alignment.hints.length === 0 ? (
            <p className="hint">Giai điệu đang đi đúng hướng thanh điệu, hát lên không bị nghe nhầm chữ.</p>
          ) : (
            <ul className="tone-hints">
              {alignment.hints.map((h) => (
                <li key={h.noteId}>
                  <span>
                    Câu {h.line + 1}, chữ <b>{h.word.replace(/[^\p{L}]/gu, '')}</b> (thanh {TONE_LABEL[h.tone]}): giai điệu {h.went === 'up' ? 'đi lên' : 'đi xuống'} nên dễ
                    nghe thành <b>{h.heard}</b>.
                  </span>
                  <button className="btn btn-sm" onClick={() => onFixHint(h)}>
                    {h.fix === 'lower' ? 'Hạ nốt' : 'Nâng nốt'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <h3 className="side-h">Tìm chữ cùng vần</h3>
      <input
        className="input"
        value={rhymeWord}
        onChange={(e) => setRhymeWord(e.target.value)}
        placeholder={autoWord ? `Đang tìm cho “${autoWord}”, gõ chữ khác nếu muốn` : 'Gõ một chữ, ví dụ: thương'}
        aria-label="Chữ cần tìm vần"
      />
      {target && (
        <div className="rhymes">
          {suggestions.length ? (
            suggestions.map((s) => (
              <button key={s.word} className={`chip${s.bang ? '' : ' is-trac'}`} onClick={() => insert(s.word)} title={`Thanh ${s.bang ? 'bằng' : 'trắc'}. Bấm để chèn vào lời`}>
                {s.word}
              </button>
            ))
          ) : (
            <span className="hint">Chưa có gợi ý cho vần này.</span>
          )}
        </div>
      )}
    </div>
  )
}
