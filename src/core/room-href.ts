// Abhängigkeitsfrei (auch für Client-Komponenten): Link auf den Raumsteckbrief (RS-02).
export const roomHref = (roomId: string) => `/raeume/${encodeURIComponent(roomId)}`;
