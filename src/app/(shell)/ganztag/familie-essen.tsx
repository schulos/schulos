// GT-11: Mittagessen aus Sicht der Familie – Speiseplan der nächsten zwei Wochen, An-/Abmeldung je Tag mit Menüwahl bis zur Frist.
import { MEAL_HINT, type FamilyMeals } from "@/modules/ganztag/essen";
import { dateLabel } from "@/modules/ganztag/service";
import { Card } from "@schulos/ui/card";
import { MealSelect } from "./essen-select";

export function FamilyMealsCard({ child, self }: { child: FamilyMeals; self: boolean }) {
  const id = `essen-${child.id}`;
  return (
    <Card className="gap-3" aria-labelledby={id}>
      <h2 id={id} className="font-display text-xl font-bold">
        {self ? "Mittagessen" : `Mittagessen: ${child.name}`}
      </h2>
      <p className="text-sm text-muted">
        {child.mayAct ? "Je Tag anmelden und ein Menü wählen oder abmelden – bis zum Anmeldeschluss." : self ? "Anmelden können deine Eltern." : "Anmelden kann nur die Schülerin bzw. der Schüler selbst."} Keine Abrechnung über SchulOS.
      </p>
      <ul className="flex flex-col gap-3" aria-label={self ? "Mittagessen der nächsten Tage" : `Mittagessen der nächsten Tage: ${child.name}`}>
        {child.days.map((d) => {
          const ordered = d.menus.find((m) => m.number === d.ordered);
          return (
            <li key={d.date} className="flex flex-col gap-1 border-t border-border pt-3 first:border-t-0 first:pt-0 sm:flex-row sm:items-center sm:justify-between">
              <span className="flex flex-col">
                <span className="font-medium">{dateLabel(d.date)}</span>
                <span className="text-xs text-muted">Anmeldeschluss {d.deadline}</span>
              </span>
              {child.mayAct && d.open ? (
                <MealSelect label={`Mittagessen ${dateLabel(d.date)}${self ? "" : `: ${child.name}`}`} studentId={child.id} date={d.date} menus={d.menus} value={d.ordered} />
              ) : (
                <span className="text-sm">{ordered ? `Menü ${ordered.number}: ${ordered.title}` : "nicht angemeldet"}</span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted">{MEAL_HINT}</p>
    </Card>
  );
}
