export const titleStrategyLabels = {
  default: '现有默认', natural: '自然口语', quote: '原话看点', community: '有据用梗', custom: '手写标题'
} as const;
export type TitleStrategy = keyof typeof titleStrategyLabels;
export interface TitleOption {
  id: string;
  strategy: Exclude<TitleStrategy, 'custom'>;
  title: string;
  evidence?: string;
  reference?: string;
}
export interface TitleSelection { strategy: TitleStrategy; title: string; optionId?: string }
export interface TitleView {
  id: string;
  revision: string;
  version: string;
  options: TitleOption[];
  selection: TitleSelection | null;
  generated: boolean;
  job?: { id: string; status: string; output: string };
}
export interface TitleDecision extends TitleSelection {
  setId: string;
  version: string;
  mode: 'explicit' | 'retained';
}
export interface TitleStats {
  version: string;
  rows: { strategy: TitleStrategy; shown: number; selected: number; changes: number; submitted: number; succeeded: number; failed: number }[];
  passiveDefault: number;
  sets: number;
}
