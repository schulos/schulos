import type { Booklist, BooklistItem } from "./lernmittel";
import { formatEuro, formatIsbn } from "./labels";

function Items({ items, caption, price }: { items: BooklistItem[]; caption: string; price: boolean }) {
  return (
    <table className="w-full border-collapse text-sm">
      <caption className="pb-2 text-left font-semibold">{caption}</caption>
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted">
          <th className="py-1 pr-3 font-medium">Fach</th>
          <th className="py-1 pr-3 font-medium">Titel</th>
          <th className="py-1 pr-3 font-medium">ISBN</th>
          {price && <th className="py-1 text-right font-medium">Preis</th>}
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.id} className="border-b border-border/60 align-top">
            <td className="py-1.5 pr-3">
              {i.subjectName ?? "–"}
              {i.course && <span className="block text-xs text-muted">{i.course}</span>}
            </td>
            <td className="py-1.5 pr-3">
              <span className="font-medium">{i.title}</span>
              {(i.publisher || i.author) && <span className="block text-xs text-muted">{[i.author, i.publisher].filter(Boolean).join(" · ")}</span>}
            </td>
            <td className="py-1.5 pr-3 font-mono text-xs whitespace-nowrap tabular-nums">{i.isbn ? formatIsbn(i.isbn) : "–"}</td>
            {price && <td className="py-1.5 text-right whitespace-nowrap tabular-nums">{i.priceCents != null ? formatEuro(i.priceCents) : "–"}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Bücherliste eines Jahrgangs (BU-10) – auf der Seite und in der Druckansicht; ohne Personenbezug. */
export function BooklistView({ list }: { list: Booklist }) {
  const empty = !list.loan.length && !list.buy.length;
  return (
    <div className="flex flex-col gap-5">
      {list.text && <p className="text-sm whitespace-pre-line">{list.text}</p>}
      {empty && <p className="text-sm text-muted">Für diesen Jahrgang sind noch keine Lernmittel eingetragen.</p>}
      {list.loan.length > 0 && <Items items={list.loan} caption="Leiht die Schule aus" price={false} />}
      {list.buy.length > 0 && (
        <div className="flex flex-col gap-1">
          <Items items={list.buy} caption="Bitte selbst kaufen" price />
          {list.buyTotalCents > 0 && <p className="text-right text-sm font-semibold tabular-nums">zusammen {formatEuro(list.buyTotalCents)}</p>}
        </div>
      )}
    </div>
  );
}
