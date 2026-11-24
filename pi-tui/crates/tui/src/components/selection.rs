//! `selection` — drag-select post-process on the painted surface.
//!
//! Terminal-style flow selection: `(anchor, head)` cell coords are
//! normalized so the anchor is topmost; cells between are painted with
//! `INVERSE` and their symbols extracted as the copyable text.
//!
//! Wide-cluster continuation cells carry an empty symbol and are
//! indistinguishable from untouched blanks — a cell is treated as a
//! continuation only when the previous cell holds a width-2 grapheme.

use scrollback::{cell::Modifier, Surface};
use unicode_width::UnicodeWidthStr;

/// Paint `INVERSE` over the selected cells and return their text
/// (one line per surface row, trailing blanks trimmed).
pub fn apply(surface: &mut Surface, anchor: (u16, u16), head: (u16, u16)) -> String {
    let (mut a, mut b) = (anchor, head);
    if (b.1, b.0) < (a.1, a.0) {
        std::mem::swap(&mut a, &mut b);
    }
    if a == b || surface.width == 0 || surface.height == 0 {
        return String::new();
    }
    let y1 = b.1.min(surface.height - 1);
    if a.1 >= surface.height {
        return String::new();
    }
    let mut out = String::new();
    for y in a.1..=y1 {
        let x0 = if y == a.1 { a.0 } else { 0 };
        let x1 = if y == b.1 { b.0 } else { surface.width - 1 };
        let x1 = x1.min(surface.width - 1);
        let mut line = String::new();
        for x in x0..=x1 {
            if let Some(cell) = surface.cell_mut(x, y) {
                cell.modifier |= Modifier::INVERSE;
                let s = cell.symbol.as_str().to_string();
                if s.is_empty() {
                    // Continuation of a width-2 cluster → emit nothing;
                    // a real blank cell → space (trimmed at line end).
                    let prev_wide = x > 0
                        && surface
                            .cell(x - 1, y)
                            .map(|p| UnicodeWidthStr::width(p.symbol.as_str()) >= 2)
                            .unwrap_or(false);
                    if !prev_wide {
                        line.push(' ');
                    }
                } else {
                    line.push_str(&s);
                }
            }
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out.trim_end_matches('\n').to_string()
}

/// Normalized selection rect test: true when `(x, y)` is inside the
/// flow selection — used by callers that only need containment.
pub fn contains(anchor: (u16, u16), head: (u16, u16), x: u16, y: u16) -> bool {
    let (a, b) = if (head.1, head.0) < (anchor.1, anchor.0) {
        (head, anchor)
    } else {
        (anchor, head)
    };
    if y < a.1 || y > b.1 {
        return false;
    }
    (y != a.1 || x >= a.0) && (y != b.1 || x <= b.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use scrollback::cell::{Color, Modifier};
    use scrollback::{CellStyle, Surface};

    fn style() -> CellStyle {
        CellStyle {
            fg: Color::Ansi(7),
            bg: Color::Reset,
            underline: Color::Reset,
            modifier: Modifier::empty(),
        }
    }

    #[test]
    fn single_line_extracts_text() {
        let mut s = Surface::new(10, 2);
        s.draw_str(0, 0, "hello world", 10, &style(), None);
        let text = apply(&mut s, (0, 0), (4, 0));
        assert_eq!(text, "hello");
        assert!(s.cell(2, 0).unwrap().modifier.contains(Modifier::INVERSE));
        assert!(!s.cell(6, 0).unwrap().modifier.contains(Modifier::INVERSE));
    }

    #[test]
    fn multi_line_selects_full_middle_rows() {
        let mut s = Surface::new(6, 3);
        s.draw_str(0, 0, "aa bb ", 6, &style(), None);
        s.draw_str(0, 1, "cc dd ", 6, &style(), None);
        s.draw_str(0, 2, "ee ff ", 6, &style(), None);
        let text = apply(&mut s, (4, 0), (1, 2));
        assert_eq!(text, "b\ncc dd\nee");
    }

    #[test]
    fn reverse_drag_normalizes() {
        let mut s = Surface::new(10, 1);
        s.draw_str(0, 0, "abcdef", 10, &style(), None);
        assert_eq!(apply(&mut s, (4, 0), (1, 0)), "bcde");
    }

    #[test]
    fn wide_char_continuation_emits_no_space() {
        let mut s = Surface::new(10, 1);
        s.draw_str(0, 0, "你好x", 10, &style(), None);
        let text = apply(&mut s, (0, 0), (4, 0));
        assert_eq!(text, "你好x");
    }

    #[test]
    fn blank_cells_become_spaces() {
        let mut s = Surface::new(10, 1);
        s.draw_str(0, 0, "a", 1, &style(), None);
        s.draw_str(5, 0, "b", 1, &style(), None);
        let text = apply(&mut s, (0, 0), (5, 0));
        assert_eq!(text, "a    b");
    }

    #[test]
    fn same_cell_is_no_selection() {
        let mut s = Surface::new(4, 1);
        s.draw_str(0, 0, "ab", 4, &style(), None);
        assert_eq!(apply(&mut s, (1, 0), (1, 0)), "");
    }

    #[test]
    fn contains_matches_flow_region() {
        assert!(contains((2, 0), (4, 2), 0, 1));
        assert!(contains((2, 0), (4, 2), 3, 0));
        assert!(!contains((2, 0), (4, 2), 1, 0));
        assert!(!contains((2, 0), (4, 2), 5, 2));
    }
}
