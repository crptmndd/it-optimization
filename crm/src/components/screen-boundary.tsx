import { Component, type ReactNode } from "react";
import { Button, EmptyState } from "@/components/ui";

/**
 * Упавший экран не должен оставлять пустую страницу: на старом API новая CRM падает
 * сразу после входа, и без этой обёртки человек видит белый лист без единого слова,
 * а переход по меню уже не спасает. Стоит вокруг содержимого раздела: шапка и меню
 * остаются живыми, а смена раздела сбрасывает её вместе с `key` обёртки в `shell.tsx`.
 */
export class ScreenBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="space-y-4">
        <EmptyState
          title="Раздел не открылся"
          note="Похоже, версии CRM и сервера разошлись: это бывает во время выката. Обновите страницу через несколько минут. Другие разделы могут работать."
        />
        <div className="flex justify-center">
          <Button onClick={() => window.location.reload()}>Обновить страницу</Button>
        </div>
      </div>
    );
  }
}
