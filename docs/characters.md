# Characters references

Базовые персонажи (из референсов в корне):
- `ref_character_pigeon.jpeg` — голубь в кепке/косухе.
- `ref_character_duck.jpeg` — утёнок в гавайке со стаканом.
- `ref_character_cat.jpeg` — рыжий кот в подтяжках.
- `ref_character_dog.png` / `Screenshot 2026-01-20 at 11.58.13 PM.png` — собака в косухе (есть вариант на прозрачном фоне).

Для Stage 2 (ассеты):
- Экспортировать по одному GLB на персонажа (pivot в центре, лицо вдоль +Z).
- Клиент теперь понимает отдельные GLB по сторонам: `player_cat.glb`, `player_dog.glb`, `player_duck.glb`, `player_pigeon.glb`; при их отсутствии используется фолбек `player.glb`.
- Масштаб: вписывать ширину около 2.2 юнита, глубина ~0.7 юнита, центр в (0,0,0).
