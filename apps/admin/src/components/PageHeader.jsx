// One page header shape.
//
// The old one put the title, a status note and the description on a single flex
// row, so the description ended up squeezed against the right-hand edge next to
// the action button — reading as a caption on the button rather than as a
// description of the page. Pages managed to show two of them.
//
// Title and action share the top line. The description gets the line below, at
// full width, where a sentence belongs.

export default function PageHeader({ title, description, action, note }) {
  return (
    <div className="pagehead">
      <div className="pagehead-top">
        <h1>{title}</h1>
        {note && <span className="pagehead-note">{note}</span>}
        {action && <div className="pagehead-action">{action}</div>}
      </div>
      {description && <p className="pagehead-desc">{description}</p>}
    </div>
  );
}
