# STL-Werkstatt

**Deutsch** · [English below](#english)

Kleine Änderungen an STL-Dateien – ohne CAD-Programm und ohne Gefummel im Slicer.
Bohrungen schließen, verschieben, im Durchmesser ändern oder neu setzen: Maus über die Bohrung, Rechtsklick, fertig.

## Benutzen

1. [`STL-Werkstatt.html`](STL-Werkstatt.html) herunterladen und doppelklicken (läuft in Firefox, Chrome, Edge – offline, nichts wird hochgeladen).
   Alternativ den Link der GitHub-Pages-Seite nutzen, falls vorhanden.
2. STL-Datei ins Fenster ziehen.
3. Mit der Maus über eine Bohrung fahren – sie leuchtet orange, Ø und Tiefe werden angezeigt.
4. **Rechtsklick** auf die Bohrung:
   - Bohrung schließen
   - Durchmesser ändern (mit Schnellwahl für Schraubenlöcher M3–M8)
   - Verschieben (pro Achse X/Y/Z ein Maß in mm, auch negativ)
5. Rechtsklick auf eine freie Fläche: **Neue Bohrung hier** (Durchmesser, Tiefe oder durchgehend, Feinverschiebung).
6. Strg+Z = rückgängig · 💾 Speichern legt `<Name>_bearbeitet.stl` im Download-Ordner ab. Das Original bleibt unverändert.

Maus: links drehen, rechts verschieben, Rad zoomen.

## Grenzen

- Erkannt werden runde Bohrungen (auch mit Fase oder Nut), keine Langlöcher oder Teilrundungen.
- Das Ergebnis ist ein dichtes Netz (die Anzeige „Netz: dicht ✓“ sagt es dir). Trotzdem im Slicer kurz prüfen.
- Bisher nur unter Linux ausführlich getestet; Rückmeldungen zu Windows/Mac sind willkommen.

## Selbst bauen

Node.js installieren, dann:

```bash
npm install
npm run build      # erzeugt STL-Werkstatt.html neu
```

Quellen: `src/core.js` (STL lesen/schreiben, Bohrungserkennung, Boolesche Operationen),
`src/main.js` (Oberfläche), `src/index.template.html` (Seitengerüst).

## Lizenz

MIT – siehe [LICENSE](LICENSE). Enthaltene Bibliotheken (three.js, three-mesh-bvh, Manifold):
[LIZENZEN-Drittanbieter.txt](LIZENZEN-Drittanbieter.txt).

---

## English

Small edits to STL files without CAD and without fiddling in the slicer.
Close, move, resize or add holes: hover a hole, right-click, done. Runs entirely in your browser, nothing is uploaded.

**Use:** download [`STL-Werkstatt.html`](STL-Werkstatt.html), double-click it, drag in an STL.
Hover a hole (it turns orange), right-click → *close hole* / *change diameter* / *move* (per-axis offset in mm).
Right-click on a free surface → *new hole here*. Ctrl+Z undoes; *Save* writes `<name>_bearbeitet.stl`.

**Limits:** recognises round holes (incl. chamfers/grooves), not slots. Mainly tested on Linux. Always check the result in your slicer.

**Build:** `npm install && npm run build`. **License:** MIT (see [LICENSE](LICENSE)).
