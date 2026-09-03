export type WeComCardColor = 0 | 1 | 2 | 3;
export type WeComCardButtonVariant = 'primary' | 'secondary' | 'danger';

export interface WeComCardFact {
  label: string;
  value: string;
}

export interface WeComCardButton {
  key: string;
  text: string;
  variant?: WeComCardButtonVariant;
}

export interface WeComCardSelectionOption {
  id: string;
  text: string;
}

export interface WeComCardSelection {
  questionKey: string;
  title: string;
  options: WeComCardSelectionOption[];
}

export interface WeComCardView {
  kind: 'interactive' | 'notice';
  taskId: string;
  source: string;
  sourceColor?: WeComCardColor;
  title: string;
  description?: string;
  subtitle?: string;
  facts?: WeComCardFact[];
  selection?: WeComCardSelection;
  buttons?: WeComCardButton[];
  noticeUrl?: string;
}
