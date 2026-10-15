/**
 * The box every transcript row sits in (`TranscriptRowItem`). Its padding is
 * what gives the jump highlight room, and with the margin under it sets the
 * rhythm between messages: 8px of padding either side and 4px of margin,
 * 20px from one message to the next. The width caps the text column at 800px.
 *
 * A ticket's activity puts its rows in the same box, so it keeps the same
 * rhythm as the chat beside it.
 */
export const TRANSCRIPT_ROW_CLASS = "mx-auto mb-1 w-full max-w-[816px] rounded-xl p-2"
