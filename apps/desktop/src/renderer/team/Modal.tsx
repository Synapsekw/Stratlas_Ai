import { Dialog, Icon, t, type IconName } from '@aio/ui';
import { type ReactNode } from 'react';

/**
 * A team dialog on the shared Dialog, which portals to the body: the chip that opens it sits in
 * the title bar, whose drag region would otherwise swallow the clicks. While `busy`, Escape, the
 * scrim and the close button leave it open.
 */
export function Modal(props: {
  id: string;
  icon: IconName;
  title: string;
  sub?: string;
  busy?: boolean;
  onClose(): void;
  footer: ReactNode;
  children: ReactNode;
}) {
  const close = () => {
    if (!props.busy) props.onClose();
  };
  return (
    <Dialog
      open
      onClose={close}
      testId={props.id}
      className="team-dlg"
      closeLabel={t('team.close')}
      title={
        <>
          <Icon name={props.icon} size={16} /> {props.title}
        </>
      }
      {...(props.sub ? { description: <span dir="auto">{props.sub}</span> } : {})}
      footer={props.footer}
    >
      {props.children}
    </Dialog>
  );
}
