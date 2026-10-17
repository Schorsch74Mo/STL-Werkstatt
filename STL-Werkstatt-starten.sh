#!/bin/sh
# Öffnet die STL-Werkstatt im Standard-Browser
xdg-open "$(dirname "$(readlink -f "$0")")/STL-Werkstatt.html"
