/** Public status only; stored session credentials are never returned to the browser. */
export interface BilibiliLoginStatus {
  revision: string;
  expectedUid: string;
  login: 'valid' | 'invalid' | 'unavailable' | 'missing';
  accountName?: string;
  refresh: 'needed' | 'not-needed' | 'unavailable';
  hasRefreshToken: boolean;
  service: 'valid' | 'invalid' | 'unavailable';
  recorderSync: 'current' | 'pending' | 'disabled' | 'unavailable';
  updatedAt: string;
  checkedAt: string;
}
export interface BilibiliLoginInput { revision: string; cookie: string; acTimeValue: string }
export interface BilibiliLoginSaved { status: BilibiliLoginStatus; message: string }
