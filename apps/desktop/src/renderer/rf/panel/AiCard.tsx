/**
 * The Coverage panel's AI card (spec "The Coverage panel", 1): one sentence on what Auto-plan
 * does, **Auto-plan & run**, a "set up by hand" link that opens step 2, and **Use cell export**, a
 * file pick. Dropping a `.csv` on the card does what the pick does. Once a group came from an
 * export, Use cell export is the main action. The card only calls its handlers; the bench wires
 * them to Auto-plan.
 */
import { Button, useT } from '@aio/ui';
import { useRef, useState, type DragEvent, type ReactElement } from 'react';

export interface AiCardProps {
  onAutoplan: () => void;
  onSetUpByHand: () => void;
  /** The text of the cell export the person picked or dropped. */
  onUseExport: (csvText: string) => void;
  /** A field group already came from a cell export. */
  exportAvailable: boolean;
  disabled?: boolean | undefined;
  /** Reads a picked or dropped file; tests pass their own. */
  readFile?: ((file: File) => Promise<string>) | undefined;
}

const isCsv = (f: File): boolean => f.name.toLowerCase().endsWith('.csv') || f.type === 'text/csv';

const hasFiles = (e: DragEvent): boolean => [...e.dataTransfer.types].includes('Files');

export function AiCard({
  onAutoplan,
  onSetUpByHand,
  onUseExport,
  exportAvailable,
  disabled = false,
  readFile,
}: AiCardProps): ReactElement {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const use = (file: File | undefined) => {
    if (disabled || !file || !isCsv(file)) return;
    void (readFile ? readFile(file) : file.text()).then(onUseExport, () => undefined);
  };
  return (
    <div
      className="rf-ai-card"
      data-testid="rf-ai-card"
      data-drop={over || undefined}
      onDragOver={(e) => {
        if (disabled || !hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        if (disabled || !hasFiles(e)) return;
        e.preventDefault();
        use([...e.dataTransfer.files].find(isCsv));
      }}
    >
      <h4 className="rf-ai-title">
        <span className="rf-spark" aria-hidden="true">
          ✦
        </span>
        {t('rf.steps.ai.title')}
      </h4>
      <p className="rf-ai-body">{over ? t('rf.steps.ai.drop') : t('rf.steps.ai.body')}</p>
      <div className="rf-ai-acts">
        <Button
          variant={exportAvailable ? 'secondary' : 'primary'}
          size="md"
          disabled={disabled}
          data-testid="rf-ai-autoplan"
          onClick={onAutoplan}
        >
          <span className="rf-spark" aria-hidden="true">
            ✦
          </span>{' '}
          {t('rf.steps.ai.autoplan')}
        </Button>
        <Button
          variant={exportAvailable ? 'primary' : 'secondary'}
          size="md"
          icon="import"
          disabled={disabled}
          tip={t('rf.steps.ai.exportTip')}
          data-testid="rf-ai-export"
          onClick={() => input.current?.click()}
        >
          {t('rf.steps.ai.useExport')}
        </Button>
        <Button variant="link" data-testid="rf-ai-by-hand" onClick={onSetUpByHand}>
          {t('rf.steps.ai.byHand')}
        </Button>
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv"
          hidden
          tabIndex={-1}
          aria-hidden="true"
          data-testid="rf-ai-export-file"
          onChange={(e) => {
            use(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
