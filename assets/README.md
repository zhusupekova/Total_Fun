# Assets stub

Place GLB models here (exported from Blender, glTF/GLB):

- `arena.glb` — статичная сцена ринга/бортов (сейчас: placeholder Box.glb из glTF Sample Assets).
- `player.glb` — базовая модель персонажа, клонируется на 4 слота. Ориентация: лицом вдоль +Z. Масштаб: ширина ~2.2, глубина ~0.7. (сейчас: placeholder Suzanne.glb из glTF Sample Assets).
- `ball.glb` — модель мяча, центр в (0,0,0), радиус ~0.45. (сейчас: placeholder MetalRoughSpheresNoTextures.glb).

Требования для финальных ассетов:
- Центрируйте pivot в (0,0,0) без смещения.
- Минимум материалов/текстур, без тяжёлых шейдеров.
- Экспорт без анимаций (на Stage 1/2).

Фолбэк: если файлов нет, игра использует примитивы (бокс/сфера) из `src/main.js`.
