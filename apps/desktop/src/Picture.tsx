import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from './ui.tsx';

// A picture in the conversation, small where it stands; a click shows it whole until closed. `link` is the path
// it came from, for the conversation's menu of a linked file.
export function Picture({
  src,
  alt,
  link,
  onError,
}: {
  src: string;
  alt: string;
  link?: string;
  onError?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="picture"
        title="点击放大"
        data-link={link}
        onClick={() => setOpen(true)}
      >
        <img src={src} alt={alt} onError={onError} />
      </button>
      {open &&
        createPortal(
          <Modal title={alt || '图片'} onClose={() => setOpen(false)}>
            <div className="picture-view" onContextMenu={(event) => event.stopPropagation()}>
              <img src={src} alt={alt} />
            </div>
          </Modal>,
          document.body,
        )}
    </>
  );
}
