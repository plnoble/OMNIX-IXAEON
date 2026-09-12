/**
 * 公开搜索查询不得夹带私人原文。这不是脱敏证明，只是本地拦一道明显泄漏。
 * 真正外发仍须用户配置的搜索服务；未配置时 search_web 继续失败。
 */

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<!\d)(?:\+?\d[\d\s\-()]{8,}\d)/g;
const PATH_WIN = /[A-Za-z]:\\[^\s]+/g;
const PATH_UNIX = /(?:^|\s)(\/(?:home|Users|root)\/[^\s]+)/g;
const TOKENISH = /\b(?:sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._\-]{8,})\b/gi;
const PRIVATE_HINT = /我的(?:密码|密钥|身份证|银行卡|住址)|身份证号|银行卡号|家庭住址|私人聊天原文/;

export interface SanitizedQuery {
  query: string;
  redacted: boolean;
  reasons: string[];
}

export function sanitizePublicQuery(raw: string): SanitizedQuery {
  const reasons: string[] = [];
  let query = raw.trim().replace(/\s+/g, ' ');
  const mark = (re: RegExp, reason: string, replacement = '[已省略]') => {
    if (re.test(query)) {
      reasons.push(reason);
      query = query.replace(re, replacement);
    }
    re.lastIndex = 0;
  };
  mark(EMAIL, 'email');
  mark(PHONE, 'phone');
  mark(PATH_WIN, 'local-path');
  mark(PATH_UNIX, 'local-path');
  mark(TOKENISH, 'credential');
  if (PRIVATE_HINT.test(query)) {
    reasons.push('private-hint');
    query = query.replace(PRIVATE_HINT, '[已省略私人细节]');
  }
  query = query.replace(/\s+/g, ' ').trim();
  if (query.length > 200) {
    query = query.slice(0, 200).trim();
    reasons.push('truncated');
  }
  return { query, redacted: reasons.length > 0, reasons };
}
