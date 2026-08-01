import { useState, useCallback } from 'react';
import ConfirmDialog from '../components/ConfirmDialog';

// Turns a window.confirm() call site into a one-liner, so replacing fifteen of
// them is a mechanical change rather than fifteen chances to introduce a bug.
//
//   const [confirmNode, ask] = useConfirm();
//   ...
//   ask({ title: 'Delete it?', body: 'Gone for good.', danger: true,
//         confirmLabel: 'Delete', onConfirm: () => api.remove(id) });
//   ...
//   return (<>{confirmNode}  …the rest of the component… </>);
//
// The dialog stays open while onConfirm runs and closes when it resolves, so a
// slow request cannot be fired twice by an impatient second click.

export default function useConfirm() {
  const [req, setReq] = useState(null);

  const ask = useCallback((options) => setReq(options), []);

  const node = req ? (
    <ConfirmDialog
      title={req.title}
      confirmLabel={req.confirmLabel}
      cancelLabel={req.cancelLabel}
      danger={req.danger}
      typeToConfirm={req.typeToConfirm}
      onCancel={() => setReq(null)}
      onConfirm={async () => {
        await req.onConfirm();
        setReq(null);
      }}
    >
      {req.body}
    </ConfirmDialog>
  ) : null;

  return [node, ask];
}
