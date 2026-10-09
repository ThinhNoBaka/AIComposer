// Kích thước dùng chung cho timeline (khớp với --label-w trong index.css).

/** Bề rộng cột nhãn bên trái timeline. */
export const LABEL_W = 76
/** Số ô trống luôn hiện sau cuối bài để viết tiếp. */
export const GHOST_BARS = 8
/** Các mức thu phóng: bề rộng một bước (1/16 nốt) tính bằng px. */
export const ZOOMS = [6, 9, 12, 16, 22]

const SOLFEGE = ['Đô', 'Đô#', 'Rê', 'Rê#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si']

export function pitchLabel(p: number): string {
  return `${SOLFEGE[p % 12]} ${Math.floor(p / 12) - 1}`
}
