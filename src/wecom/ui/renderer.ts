import type { TemplateCard } from '@wecom/aibot-node-sdk';
import type { WeComCardView } from './model';
import { buttonStyle } from './theme';

export function renderWeComCard(view: WeComCardView): TemplateCard {
  if (view.kind === 'notice') {
    return {
      card_type: 'text_notice',
      card_action: { type: 1, url: view.noticeUrl ?? 'https://work.weixin.qq.com/' },
      source: {
        desc: view.source,
        ...(view.sourceColor === undefined ? {} : { desc_color: view.sourceColor }),
      },
      main_title: {
        title: view.title,
        ...(view.description ? { desc: view.description } : {}),
      },
      ...(view.subtitle ? { sub_title_text: view.subtitle } : {}),
      ...(view.facts?.length
        ? {
            horizontal_content_list: view.facts.map((fact) => ({
              keyname: fact.label,
              value: fact.value,
            })),
          }
        : {}),
      task_id: view.taskId,
    };
  }

  return {
    card_type: 'button_interaction',
    card_action: { type: 0 },
    source: {
      desc: view.source,
      ...(view.sourceColor === undefined ? {} : { desc_color: view.sourceColor }),
    },
    main_title: {
      title: view.title,
      ...(view.description ? { desc: view.description } : {}),
    },
    ...(view.subtitle ? { sub_title_text: view.subtitle } : {}),
    ...(view.facts?.length
      ? {
          horizontal_content_list: view.facts.map((fact) => ({
            keyname: fact.label,
            value: fact.value,
          })),
        }
      : {}),
    ...(view.selection
      ? {
          button_selection: {
            question_key: view.selection.questionKey,
            title: view.selection.title,
            option_list: view.selection.options,
          },
        }
      : {}),
    ...(view.buttons?.length
      ? {
          button_list: view.buttons.map((button) => ({
            text: button.text,
            key: button.key,
            style: buttonStyle(button.variant),
          })),
        }
      : {}),
    task_id: view.taskId,
  };
}
