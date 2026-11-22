/**
 * Vietnamese text helpers for checking that a command the model proposes
 * really comes from what the user said.
 */

const SPLIT = /[^\p{L}\p{N}]+/u;

/** Lower case without tone marks ("Đóng mái" → "dong mai"): speech-to-text often gets tones wrong. */
export function fold(text: string): string {
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase();
}

function tokens(text: string, folded: boolean): string[] {
    const source = folded ? fold(text) : text.normalize('NFC').toLowerCase();
    return source.split(SPLIT).filter(Boolean);
}

/** Words that cancel a command ("đừng mở cửa", "thôi khỏi mở cửa"); compared with tone marks. */
const NEGATIONS = new Set(['đừng', 'không', 'chưa', 'khoan', 'khỏi', 'ko', 'cấm']);

/** A negation at [index], except in compounds: "không khí" (air), "ra khỏi" (leave). */
function negationAt(words: string[], index: number): boolean {
    const word = words[index];
    if (!NEGATIONS.has(word)) return false;
    if (word === 'không' && words[index + 1] === 'khí') return false;
    if (word === 'khỏi' && words[index - 1] === 'ra') return false;
    return true;
}

export type Grounding = 'ok' | 'missing' | 'negated';

/** Where [quote] best lines up in [message] (most consecutive words matching; the later one on ties). */
function locate(quote: string[], message: string[]): number {
    let best = -1;
    let bestScore = 0;
    for (let start = 0; start < message.length; start += 1) {
        let score = 0;
        while (score < quote.length && message[start + score] === quote[score]) score += 1;
        if (score > 0 && score >= bestScore) {
            best = start;
            bestScore = score;
        }
    }
    return best >= 0 ? best : message.findIndex(word => quote.includes(word));
}

/**
 * Is [quote] (the words the model says it acted on) in [message]? At least
 * 60% of its words must appear (tone marks ignored), and the command must not
 * be negated: no negation in it or in the two words before it.
 */
export function groundQuote(quote: string, message: string): Grounding {
    const quoteWords = tokens(quote, true);
    const messageWords = tokens(message, true);
    if (quoteWords.length === 0) return 'missing';
    const found = quoteWords.filter(word => messageWords.includes(word));
    if (found.length / quoteWords.length < 0.6) return 'missing';
    const start = locate(quoteWords, messageWords);
    const original = tokens(message, false);
    const quoted = tokens(quote, false);
    for (let index = Math.max(0, start - 2); index < Math.min(original.length, start + quoteWords.length); index += 1) {
        if (negationAt(original, index)) return 'negated';
    }
    if (quoted.some((_, index) => negationAt(quoted, index))) return 'negated';
    return 'ok';
}

/** Buying words, tone marks ignored ("nâng cấp" → "nang cap"). */
const BUY_PHRASES = [
    'mua', 'nang cap', 'nang len', 'gia han', 'dang ky', 'dang ki', 'thanh toan',
    'len goi', 'doi goi', 'doi sang', 'chuyen goi', 'chuyen sang', 'lay goi', 'chot',
];
/** How a reply starts when it says yes ("Có", "Ừ", "OK", "Đồng ý"...). */
const YES_PHRASES = ['co', 'ok', 'oke', 'okay', 'u', 'uh', 'um', 'dong y', 'duoc', 'xac nhan', 'chot', 'lam di'];

const hasPhrase = (words: string[], phrases: string[]) => {
    const text = ` ${words.join(' ')} `;
    return phrases.some(phrase => text.includes(` ${phrase} `));
};

/**
 * Does [message] ask to buy a plan? Either in its own words ("nâng cấp lên gói
 * Cơ bản"), or as an answer to the assistant asking whether or how long to buy
 * ("Bạn có muốn nâng cấp không?" → "Có"; "… 1 tháng hay 12 tháng?" → "12 tháng").
 * Asking a price or comparing plans does not.
 */
export function asksToBuy(message: string, previousReply: string | null): boolean {
    const words = tokens(message, true);
    if (hasPhrase(words, BUY_PHRASES)) return true;
    if (!previousReply?.includes('?') || !hasPhrase(tokens(previousReply, true), BUY_PHRASES)) return false;
    const yes = YES_PHRASES.some(phrase => ` ${words.join(' ')} `.startsWith(` ${phrase} `));
    return yes || words.includes('thang') || words.includes('nam');
}

export function clip(text: string, max: number): string {
    const value = text.replace(/\s+/g, ' ').trim();
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
