#pragma once

#include <algorithm>

namespace niuma::reminder {

struct BubbleRect {
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;
};

enum class VerticalAxis { Up, Down };

// Selects a full bubble rectangle near a widget and clamps it to the usable
// work area. Coordinates use the platform's native origin convention.
inline BubbleRect PlaceBubble(const BubbleRect& widget, const BubbleRect& workArea,
                              double bubbleWidth, double bubbleHeight, double gap,
                              VerticalAxis verticalAxis) {
  const double minX = workArea.x + gap;
  const double maxX = std::max(minX, workArea.x + workArea.width - bubbleWidth - gap);
  const double minY = workArea.y + gap;
  const double maxY = std::max(minY, workArea.y + workArea.height - bubbleHeight - gap);
  const double centeredX = widget.x + (widget.width - bubbleWidth) / 2;
  const double aboveY = verticalAxis == VerticalAxis::Up
      ? widget.y + widget.height + gap
      : widget.y - bubbleHeight - gap;
  double x = centeredX;
  double y = aboveY;
  const bool aboveFits = centeredX >= minX && centeredX <= maxX &&
      aboveY >= minY && aboveY <= maxY;
  if (!aboveFits) {
    const double leftX = widget.x - bubbleWidth - gap;
    const double rightX = widget.x + widget.width + gap;
    if (leftX >= minX && leftX <= maxX) {
      x = leftX;
      y = widget.y + (widget.height - bubbleHeight) / 2;
    } else if (rightX >= minX && rightX <= maxX) {
      x = rightX;
      y = widget.y + (widget.height - bubbleHeight) / 2;
    } else {
      x = centeredX;
      y = verticalAxis == VerticalAxis::Up
          ? widget.y - bubbleHeight - gap
          : widget.y + widget.height + gap;
    }
  }
  x = std::clamp(x, minX, maxX);
  y = std::clamp(y, minY, maxY);
  return {x, y, bubbleWidth, bubbleHeight};
}

}  // namespace niuma::reminder
