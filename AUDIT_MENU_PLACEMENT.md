# Расположение меню на macOS: правила и рекомендации для Mine

Исследование 15.11.2026 по рабочей копии `youtube-referer`. Код, спецификации и планы не менялись. Поведение приложений на этом компьютере не проверялось: всё ниже взято из документации Apple, заголовков SDK, исходников Chromium и Firefox и отчётов разработчиков. Рядом с каждым правилом указано, чем оно подтверждено: документацией, исходным кодом, наблюдением из чужого отчёта или это предположение.

## 1. Итог

- **Полноэкранный режим.** Меню в отдельном окне может лежать поверх полноэкранного окна своего же приложения: для этого у AppKit есть документированный флаг `fullScreenAuxiliary`, и проба его уже ставит. Что именно держит окно поверх на текущей версии macOS, из источников не установить (отчёты расходятся), поэтому это проверяют при реализации.
- **Направление.** Меню от кнопки открывается вниз и выровнено по краю кнопки, который ближе к краю панели: у кнопки справа по правому краю, слева по левому. Если снизу нет места, меню открывается вверх. Контекстное меню открывается вправо и вниз от указателя. Подменю открывается вправо от строки и переходит влево, когда справа нет места.
- **Внутрь окна или наружу.** Ни у Apple, ни у Chromium предпочтения «внутрь окна» нет. Chromium считает границей рабочую область экрана и вообще не смотрит на окно. Меню Chrome у правого края «растёт внутрь» потому, что его правый край совпадает с правым краем кнопки, а не потому, что оно избегает выхода за окно.
- **Что заменить в пробе.** Заменить стоит поле 8 px от края экрана (у Chromium и AppKit поля нет), смещение 2 px от указателя у контекстного меню (AppKit ставит угол меню в точку события), границу у выреза экрана и источник границы в полноэкранном режиме. Остальное в пробе уже соответствует и Chromium, и документации.

## 2. Вопросы пользователя 15.11.2026

1. Как ведут себя меню в полноэкранном режиме.
2. В какую сторону открываются меню: вверх, вниз, влево, вправо. Прежним ориентиром был край окна, теперь нужна логика настольного приложения.
3. Куда отдавать приоритет: внутрь окна или наружу. Пользователь заметил, что Chrome открывает меню от кнопки у правого края внутрь окна и при этом выпускает его за нижний край окна.

## 3. Найденные правила по пунктам

### 3.1 Направление по виду меню

**Что документировано.**

- Руководство Apple не задаёт сторону и выравнивание ни для одного вида меню. На странице [Pull-down buttons](https://developer.apple.com/design/human-interface-guidelines/pull-down-buttons) сказано: «No additional considerations for macOS». На страницах [Pop-up buttons](https://developer.apple.com/design/human-interface-guidelines/pop-up-buttons), [Context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus) и [Menus](https://developer.apple.com/design/human-interface-guidelines/menus) положения меню тоже нет.
- Руководство разделяет виды по назначению. Pull-down button показывает команды, связанные с действием кнопки, и после выбора меню закрывается. Pop-up button показывает плоский список взаимоисключающих значений. Если нужны список действий, множественный выбор или подменю, Apple велит брать pull-down ([Pop-up buttons](https://developer.apple.com/design/human-interface-guidelines/pop-up-buttons)).
- Для контекстного меню `NSMenu.popUpContextMenu` заголовок SDK говорит: левый верхний угол меню стоит в точке события, а если из-за этого меню ушло бы за экран с прокруткой, его сдвигают вверх, чтобы оно поместилось ([NSMenu.h](https://developer.apple.com/documentation/appkit/nsmenu/popupcontextmenu(_:with:for:)), текст комментария в файле `AppKit.framework/Headers/NSMenu.h` из Xcode).
- Для `popUpMenuPositioningItem:atLocation:inView:` документация: левый верхний угол переданного пункта ставится в заданную точку. Без пункта в точку ставится левый верхний угол меню. Какой угол, левый или правый, решает `userInterfaceLayoutDirection` вида или приложения. Если вид не задан, точка считается в координатах экрана ([popUp(positioning:at:in:)](https://developer.apple.com/documentation/appkit/nsmenu/popup(positioning:at:in:)), заголовок `NSMenu.h`). Для языков слева направо это левый верхний угол, для языков справа налево правый.
- Так устроено меню выбора значения: AppKit ставит выбранный пункт поверх кнопки. Прямой фразы об этом в современной документации нет, но механизм следует из первого абзаца про положение пункта. Старое руководство Apple для Mac OS 8 описывает то же словами: меню выбора «acts like other menus», а при упоре в верх или низ экрана «it scrolls like other menus» ([Mac OS 8 HIG, Pop-up menus](https://discmaster.textfiles.com/file/32774/Dev.CD%20Dec%2098%20RL2.toast/Technical%20Publications/mac/HIGuidelines/HIGuidelines-91.html?html=true), документ 1990-х годов).
- У `NSPopUpButton` и `NSPopUpButtonCell` есть свойство `preferredEdge`. Заголовок SDK: оно служит «for pull-down buttons and for popups under severe screen position restrictions» и задаёт край элемента, от которого выходит меню ([NSPopUpButton.preferredEdge](https://developer.apple.com/documentation/appkit/nspopupbutton/preferrededge)). Значение по умолчанию и то, какой край AppKit выбирает сам, не документированы.
- Подменю в руководстве описано только иерархически: оно «functionally identical» меню, глубину советуют держать в один уровень, а в контекстном меню подменю не больше одного уровня ([Menus](https://developer.apple.com/design/human-interface-guidelines/menus), [Context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus)). Сторону подменю документация AppKit не называет.

**Что показывает Chromium** (исходники `ui/views/controls/menu`, ветка main на 15.11.2026).

- Корневое меню по умолчанию стоит ниже якоря, его левый край совпадает с левым краем якоря. Это якорь `kTopLeft`. С якорем `kTopRight` правый край меню совпадает с правым краем якоря ([menu_controller.cc, строки 3350–3365](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_controller.cc), [menu_types.h](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_types.h)). В языках справа налево якоря зеркалятся ([menu_types.h](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_types.h)).
- Главное меню Chrome (три точки) открывается с якорем `kTopRight` ([app_menu.cc, строки 1139–1143](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/views/toolbar/app_menu.cc)). Это ответ на наблюдение пользователя: правый край меню совпадает с правым краем кнопки, поэтому меню растёт влево.
- Контекстное меню от мыши и от клавиатуры получает якорь `kTopLeft`, от касания `kBottomCenter` ([menu_runner.cc, строки 76–90](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_runner.cc)).
- Подменю открывается справа от строки родителя (слева в языках справа налево), с перекрытием 3 px по горизонтали, а его верхний край стоит на верхнем краю строки за вычетом верхнего поля поверхности ([menu_controller.cc, строки 3310–3325](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_controller.cc), `submenu_horizontal_overlap = 3` в [menu_config.h](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_config.h)).
- Меню выбора значения (combobox) в Chromium не накрывает кнопку выбранным пунктом, а стоит под ней и не уже её: `menu_bounds.set_width(max(width, anchor.width))` ([menu_controller.cc, строки 3290–3292](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_controller.cc)).
- Контекстные меню Chrome на macOS Chromium отдаёт системному `NSMenu`: он берёт центр границ якоря как точку события и вызывает системный показ ([menu_runner_impl_cocoa.mm](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_runner_impl_cocoa.mm)). Меню, нарисованные самим Chromium (главное меню, выпадающие списки), идут по правилам выше.

**Что остаётся предположением.** Какой край кнопки выравнивает системный pull-down в панели инструментов Finder, Safari или Notes, источники не называют. По памяти о системных приложениях меню от кнопки выходит вниз с выравниванием по ближайшему краю, но это наблюдение без источника, и правилом оно здесь не считается.

### 3.2 Что ограничивает меню

- **Документировано.** Системное меню по умолчанию ограничено «bounds appropriate for the given screen», то есть рамкой экрана, а не окна. Приложение может сузить рамку делегатом `confinementRectForMenu:onScreen:`, но результат «may not be honored in all cases» ([NSMenu.h](https://developer.apple.com/documentation/appkit/nsmenu), заголовок SDK).
- **Документировано.** Руководство для visionOS прямо говорит: «As in macOS, an open menu in a visionOS window can appear outside of the window's boundaries» ([Menus, раздел visionOS](https://developer.apple.com/design/human-interface-guidelines/menus)). Это единственная фраза Apple о выходе меню за окно на macOS.
- **Документировано.** `NSScreen.visibleFrame` — область, где безопасно рисовать содержимое. Она не включает Dock и строку меню, а на Mac с вырезом камеры не включает и вырез с боковыми участками; для них есть `auxiliaryTopLeftArea` и `auxiliaryTopRightArea`. Даже при скрытом Dock область может быть меньше экрана, потому что система держит узкую полосу для показа Dock ([visibleFrame](https://developer.apple.com/documentation/appkit/nsscreen/visibleframe)). `safeAreaInsets` сообщает отступы, за которыми содержимое не закрыто вырезом ([safeAreaInsets](https://developer.apple.com/documentation/appkit/nsscreen/safeareainsets)).
- **Наблюдение из исходников.** Chromium берёт границей `display.work_area()` экрана, ближайшего к началу якоря, а если якорь в рабочую область не входит, но входит в границы экрана, берёт границы экрана целиком ([menu_controller.cc, строки 2660–2688](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_controller.cc)). Окно приложения нигде не участвует.
- **Наблюдение из исходников.** Комментарий Chromium к системному меню: рядом с Dock Cocoa ограничивает размер меню, чтобы оно не перекрывало Dock, и добавляет стрелку прокрутки ([web_menu_runner_mac.mm](https://chromium.googlesource.com/chromium/src/+/main/content/app_shim_remote_cocoa/web_menu_runner_mac.mm)).
- **Поле до края.** Ни Apple, ни Chromium поля до края экрана не называют. Chromium прижимает меню к рабочей области без зазора (`std::clamp(x, monitor.x, monitor.right - width)` в [menu_controller.cc, строки 3434–3441](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_controller.cc)). Точное поле системного меню не документировано, и по источникам его не измерить.

### 3.3 Что происходит у края экрана

**Системное меню.**

- Контекстное меню у нижнего края: AppKit его двигает вверх, чтобы не прокручивать ([NSMenu.h](https://developer.apple.com/documentation/appkit/nsmenu/popupcontextmenu(_:with:for:))). Разработчики Firefox описывают то же словом «flipped»: меню, открытые через `popUpContextMenu`, при нехватке места переворачиваются, а `popUpMenuPositioningItem` держит левый верхний угол в заданной точке и вместо переворота обрезает меню и рисует стрелки прокрутки, даже если оно целиком поместилось бы выше ([MOZMenuOpeningCoordinator.mm](https://searchfox.org/firefox-main/source/widget/cocoa/MOZMenuOpeningCoordinator.mm)).
- Меню выбора значения у низа экрана: Chromium пишет, что рядом с Dock Cocoa ограничивает размер меню и добавляет стрелку прокрутки, а с какого-то предела этот способ не работает, и меню переставляют так, чтобы текущий пункт можно было выбрать, не получив мгновенного выбора соседнего ([web_menu_runner_mac.mm](https://chromium.googlesource.com/chromium/src/+/main/content/app_shim_remote_cocoa/web_menu_runner_mac.mm)).
- Подменю у правого края: источников от Apple нет. Косвенный признак из истории Firefox: на Mac подменю, ушедшее за экран вместо перехода влево от родителя, считалось багом ([Mozilla bug 367260](https://bugzilla.mozilla.org/show_bug.cgi?id=367260)). Это значит, что от системного меню ожидают переход влево, но отчёт описывает собственный виджет Firefox, не AppKit.

**Chromium, корневое меню.** Порядок такой ([menu_controller.cc, строки 3380–3425](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_controller.cc)):

1. Под якорем, если помещается.
2. Над якорем, если помещается.
3. Сбоку от якоря, прижатым к низу экрана, если делегат это разрешает: справа при `kTopLeft` и слева при `kTopRight`, с переходом на другую сторону, если не помещается.
4. Иначе обрезка по экрану со стрелками прокрутки.

После этого меню по обеим осям сдвигается внутрь рабочей области. Горизонтального переворота у корневого меню нет, только сдвиг. Если меню один раз открылось сверху, повторное открытие того же меню снова идёт сверху (`actual_menu_position`).

**Chromium, подменю.** Сначала на предпочитаемой стороне. Если не помещается, на другой. Если нет места ни там, ни там, меню прижимается к краю (вариант в пузыре) или сдвигается внутрь рабочей области (обычный вариант). Выбранная сторона запоминается для всей глубины: следующие подменю того же уровня открываются в ту же сторону (`SetChildMenuOpenDirectionAtDepth`, [menu_controller.cc, строки 3068–3084](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_controller.cc)).

### 3.4 Меню выше экрана

- Руководство допускает прокрутку для динамических меню: если меню состоит из пользовательского или собираемого содержимого, как «History and Bookmarks menus in Safari», длинное меню допустимо, и «scrolling is acceptable» ([Menus](https://developer.apple.com/design/human-interface-guidelines/menus)). Для контекстного меню совет противоположный: пунктов должно быть немного, потому что длинное меню трудно просматривать и прокручивать ([Context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus)).
- Системное меню, которое не помещается, прокручивается стрелками у верхнего и нижнего края (Mac OS 8 HIG, Firefox и Chromium выше описывают именно стрелки).
- Chromium ограничивает высоту меню высотой монитора и при нехватке места прокручивает стрелками: `menu_bounds.set_height(min(height, monitor.height))` и класс `MenuScrollTask` для случая, когда подменю не помещается на экране ([menu_controller.cc, строки 606 и 3292–3297](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_controller.cc)).
- Наибольшая высота системного меню в документации не названа. Размер меню в экранных координатах можно запросить, но «the menu may draw at a smaller size when shown» ([NSMenu.h](https://developer.apple.com/documentation/appkit/nsmenu)).

### 3.5 Внутрь окна или наружу

- У Apple правила «держать меню внутри окна» нет. Единственная фраза о границах, процитированная в 3.2, говорит обратное: меню может выходить за окно.
- Правила Apple для кнопок у правого края панели инструментов нет. Для popover Apple советует направить стрелку на вызвавший элемент и не закрывать его ([Popovers](https://developer.apple.com/design/human-interface-guidelines/popovers)), у `NSPopover.show(relativeTo:of:preferredEdge:)` документирован только предпочитаемый край, который система вправе заменить ([show(relativeTo:of:preferredEdge:)](https://developer.apple.com/documentation/appkit/nspopover/show(relativeto:of:preferrededge:))). Это другой вид элемента, не меню.
- Chromium: границей служит рабочая область экрана ([menu_controller.cc, строки 2660–2688](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_controller.cc)). Рассуждений о «внутри окна» или «наружу» ни в коде, ни в комментариях нет. Причину выбора рабочей области комментарии не объясняют; единственный комментарий рядом говорит о запуске меню из лаунчера, когда якорь лежит вне рабочей области.
- Вывод по наблюдению пользователя. Меню Chrome от кнопки у правого края растёт влево и вниз потому, что у главного меню якорь `kTopRight`: правый край меню стоит на правом краю кнопки, и первая попытка всегда «под якорем». Нижний край окна для расчёта не существует: меню вышло за него, потому что экран ниже окна свободен. Это предположение следует из кода без прямой записи автора, но другого объяснения в коде нет.

### 3.6 Полноэкранный режим и Split View

**Что документировано.**

- Руководство велит использовать системный полноэкранный режим: он сам учитывает вырез камеры ([Going full screen, macOS](https://developer.apple.com/design/human-interface-guidelines/going-full-screen)). Для собственного полноэкранного режима Apple велит применять `safeAreaInsets` к рамке экрана ([safeAreaInsets](https://developer.apple.com/documentation/appkit/nsscreen/safeareainsets)).
- `NSWindow.CollectionBehavior.fullScreenAuxiliary`: окно «displays on the same space as the full screen window» ([fullScreenAuxiliary](https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior-swift.struct/fullscreenauxiliary)). Группа `primary`, `auxiliary`, `canJoinAllApplications` действует только для полноэкранного режима и Stage Manager, и в окне допустимо не больше одного значения из группы ([CollectionBehavior](https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior-swift.struct)).
- Про Split View в руководстве есть только схема «две окна рядом» ([Multitasking](https://developer.apple.com/design/human-interface-guidelines/multitasking)). Где показывается меню и может ли оно лечь на соседнее окно, документация не говорит.

**Что известно по отчётам разработчиков** (проверить на текущей версии macOS из источников нельзя).

- Окно обычного приложения не ложится поверх полноэкранного пространства *другого* приложения. Помогают панель `NSPanel` со стилем `nonactivatingPanel`, политика активации accessory и уровень окна выше обычного ([Apple Developer Forums, тема 826308](https://developer.apple.com/forums/thread/826308) в пересказе разработчиков; [тема 800091](https://developer.apple.com/forums/thread/800091); [тема 26677](https://developer.apple.com/forums/thread/26677)).
- Причина: выведенное вперёд обычное окно активирует своё приложение, и приложение с полноэкранным окном может выйти из своего пространства. `nonactivatingPanel` этого не вызывает ([Apple Developer Forums, тема 826308](https://developer.apple.com/forums/thread/826308)).
- Отчёты расходятся в том, достаточно ли `canJoinAllSpaces` и `fullScreenAuxiliary` с высоким уровнем. Одни утверждают, что хватает, другие, что окно остаётся скрытым. Есть утверждение, что сборки macOS 26 изменили поведение `fullScreenAuxiliary`, и его снятие помогало ([samlu PR 10](https://github.com/samreshan/samlu/pull/10), [standlock PR 40](https://github.com/yagizdo/standlock/pull/40)). Это сообщения независимых авторов, не Apple.
- Проба Mine ставит окну уровень `NSPopUpMenuWindowLevel` (101) и поведение `CanJoinAllSpaces | Transient | IgnoresCycle | FullScreenAuxiliary` ([native.rs, строки 118–121 и 259–262](file:///Users/i_iii/Проекты/Личные%20проекты/local-arena/.claude/worktrees/youtube-referer/src-tauri/src/menu_panel/native.rs)). Это тот же набор, что рекомендуют отчёты, и уровень, на котором системные меню лежат над окнами.
- Предположение: главная причина проблем в чужих отчётах, активация постороннего приложения, к панели Mine не относится, потому что её открывает уже активное приложение из собственного окна. Это вывод из механизма, а не проверенный факт.
- Предположение о Split View: оба окна стоят в одном полноэкранном пространстве, поэтому окно уровня меню может лечь поверх соседнего окна. Источников нет.
- Известный сбой другого рода: родные контекстные меню Firefox внутри панелей в полноэкранном режиме не открывались, и это правили в самом Firefox ([Mozilla bug 1707869](https://bugzilla.mozilla.org/show_bug.cgi?id=1707869)). Для Mine вывод один: полноэкранный режим надо проверять отдельно для каждого способа показа меню.

### 3.7 Несколько экранов

- Chromium выбирает экран по началу якоря (`GetDisplayNearestPoint(anchor_bounds.origin())`), берёт его рабочую область и прижимает меню внутрь неё. Меню через границу экранов не переходит ([menu_controller.cc, строки 2676–2688 и 3434–3441](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_controller.cc)).
- У AppKit документирована только рамка «for the given screen» ([NSMenu.h](https://developer.apple.com/documentation/appkit/nsmenu)): меню открывается на одном экране. Какой экран выбран для окна на стыке, из документации не следует.
- Отчёты о сбоях: меню через невидимое окно не появлялось на вторичных экранах ([Apple Developer Forums, тема 106894](https://developer.apple.com/forums/thread/106894)); у Firefox подменю правого щелчка открывалось на неверном экране ([Mozilla bug 1648881](https://bugzilla.mozilla.org/show_bug.cgi?id=1648881)). Вывод из них: экран надо выбирать явно по якорю, а не полагаться на систему.
- Проба Mine уже берёт `visibleFrame` экрана, содержащего точку якоря ([native.rs, `visible_frame_at`](file:///Users/i_iii/Проекты/Личные%20проекты/local-arena/.claude/worktrees/youtube-referer/src-tauri/src/menu_panel/native.rs)).

### 3.8 Отступ от кнопки и от указателя

- **Контекстное меню.** Документированный отступ нулевой: левый верхний угол меню стоит в точке события ([NSMenu.h](https://developer.apple.com/documentation/appkit/nsmenu/popupcontextmenu(_:with:for:))). Что системное меню рисует рамку и поле внутри этой точки, из документации не видно.
- **Меню от кнопки.** У Chromium верх меню стоит ровно на нижнем крае якоря (`menu_bounds.set_y(anchor_bounds.bottom())`, [menu_controller.cc, строка 3351](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_controller.cc)), но якорем служат границы кнопки, а меню рисует свои рамку и тень. Для касания Chromium добавляет 15 px (`kTouchYPadding`). Для системного pull-down зазор не документирован и по источникам не измерен.
- **Подменю.** Перекрытие 3 px по горизонтали и выравнивание первой строки по строке родителя (Chromium, 3.1).
- Зазор 4 px от плашки кнопки в Mine — решение пользователя от 11.10.2026 ([DESIGN_SYSTEM.md, «Отступ от кнопки»](file:///Users/i_iii/Проекты/Личные%20проекты/local-arena/.claude/worktrees/youtube-referer/DESIGN_SYSTEM.md)). Источники ему не противоречат и его не подтверждают.

### 3.9 Клавиатура

- У Apple правила нет: ни руководство, ни документация AppKit не отличают положение меню, открытого с клавиатуры, от меню, открытого указателем.
- Chromium для контекстного меню с источником «клавиатура» применяет тот же якорь `kTopLeft`, что для мыши ([menu_runner.cc, строки 76–83](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_runner.cc)). Положение задаёт переданный прямоугольник, то есть элемент в фокусе. В ветке macOS для системного меню точкой события служит центр этого прямоугольника ([menu_runner_impl_cocoa.mm](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_runner_impl_cocoa.mm)).
- Для главного меню Chrome источник значения не имеет: якорь всегда `kTopRight` ([app_menu.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/views/toolbar/app_menu.cc)).

## 4. Расхождения между macOS и Chromium

| Вопрос | macOS (AppKit) | Chromium | Что взять |
|---|---|---|---|
| Выбор значения | Выбранный пункт поверх кнопки | Список под кнопкой | Chromium, см. решение 3 |
| Граница | Рамка экрана, Dock и строка меню исключены | Рабочая область экрана | Совпадают |
| Поле до края | Не документировано | Нет | Нет поля |
| Контекстное меню у края | Сдвиг вверх или переворот, при нужде прокрутка | Под, над, сбоку, затем прокрутка | Сдвиг по AppKit |
| Подменю | Сторона не документирована | Вправо, при нехватке влево, сторона запоминается | Chromium |
| Меню от кнопки | Через `preferredEdge` и положение | Выравнивание по краю якоря | Chromium |

Подробности в разделе 3. Выбор «что взять» объяснён в разделе 5.

## 5. Рекомендации для Mine

Цель пользователя: ощущение нативности на macOS. Где документация AppKit молчит, правило берётся у Chromium, потому что его меню на этой же платформе проверены миллионами пользователей и в строении совпадают с AppKit там, где AppKit документирован (граница экрана, якорь по краю, контекстное меню в точке события).

### 5.1 Общие правила для всех меню

**Правило 1. Граница — видимая область экрана, на котором лежит якорь.** Источник: `visibleFrame` ([visibleFrame](https://developer.apple.com/documentation/appkit/nsscreen/visibleframe)) и Chromium. Экран выбирается по точке якоря (центр плашки кнопки, точка указателя), а не по окну. Меню не переходит на другой экран. Границу считают заново при каждом открытии, потому что Dock и строка меню меняются.

**Правило 2. Поля до края нет.** Источник: Chromium прижимает меню к границе без зазора, а AppKit ограничивает меню рамкой экрана. Из пробы уходит поле 8 px (`EDGE_PX`), унаследованное от Radix.

**Правило 3. Окно приложения в расчёте не участвует.** Источник: HIG ([Menus, visionOS](https://developer.apple.com/design/human-interface-guidelines/menus)) и Chromium. Меню вправе закрыть полосу вкладок и соседнее окно.

**Правило 4. Меню выше доступного места прокручивается внутри.** Высота ограничивается свободным местом, лишнее уходит в прокрутку. Источник: Chromium и системные меню; руководство допускает прокрутку у динамического содержимого ([Menus](https://developer.apple.com/design/human-interface-guidelines/menus)).

**Правило 5. Вырез камеры.** Верхняя граница в полноэкранном режиме равна верхнему краю экрана за вычетом `safeAreaInsets.top`. Источник: `safeAreaInsets` и HIG ([Going full screen](https://developer.apple.com/design/human-interface-guidelines/going-full-screen)). В обычном окне `visibleFrame` вырез уже исключает. Какую часть экрана `visibleFrame` занимает в полноэкранном режиме, документация не говорит, поэтому верхней границей берут пересечение `visibleFrame` и рамки экрана за вычетом `safeAreaInsets`.

### 5.2 По видам меню

| Вид | Сторона по умолчанию | Выравнивание | Если места нет |
|---|---|---|---|
| От кнопки | Вниз | По краю плашки: у кнопки справа правый край, у кнопки слева левый | Вверх, иначе туда, где больше места, с прокруткой |
| Контекстное по правому щелчку | Вправо и вниз от точки | Угол меню в точке | Сдвиг вверх; вправо через переворот влево |
| Подменю | Вправо от строки | Верх первой строки на строке родителя | Влево; если нет места ни там, ни там, к краю с прокруткой |
| ⌘K от значка на карточке | Как от кнопки | От плашки значка | Как от кнопки |

Источники строк таблицы: меню от кнопки — Chromium (`kTopLeft`, `kTopRight`, 3.1, 3.3); контекстное — [NSMenu.h](https://developer.apple.com/documentation/appkit/nsmenu/popupcontextmenu(_:with:for:)) и [Firefox](https://searchfox.org/firefox-main/source/widget/cocoa/MOZMenuOpeningCoordinator.mm); подменю — Chromium, 3.1 и 3.3; клавиатура — Chromium, 3.9.

**Ответ на вопрос 2 (направление).** Меню от кнопки открывается вниз и выровнено по краю кнопки, ближайшему к краю экрана: в верхнем ряду у правой кнопки меню растёт влево, у левой вправо. Вверх меню уходит, только когда снизу не помещается целиком. Контекстное меню растёт вправо и вниз. Источник: Chromium и документация AppKit.

**Ответ на вопрос 3 (внутрь или наружу).** Приоритета «внутрь окна» нет ни у Apple, ни у Chromium. Главное правило: меню прижимается к кнопке по краю, а границей служит экран. Кажущееся предпочтение «внутрь» даёт выравнивание по краю кнопки. Chrome не лучший образец именно для нативности, но в этом месте он совпадает с документацией AppKit. Рекомендация: не вводить предпочтения «внутрь» или «наружу», а перенести выравнивание по краю кнопки, которое в Mine уже есть (`align="start"` и `align="end"`).

**Ответ на вопрос 1 (полноэкранный режим).** Меню в отдельном окне уровня меню с `fullScreenAuxiliary` показывается поверх полноэкранного окна Mine, это документированный механизм. Границей служит экран с учётом выреза (правило 5). Что окно действительно остаётся видимым на текущей версии macOS, нужно проверить при реализации: отчёты расходятся. Рекомендация: в проверку реализации включить три случая (окно на весь экран, Split View с соседним приложением, второй экран), а если окно не показывается, перейти на `NSPanel` с `nonactivatingPanel`, как советуют форумы Apple.

### 5.3 Что в пробе соответствует

- Граница — видимая область экрана, а не окно. Совпадает с Chromium и AppKit.
- Экран выбирается по точке якоря (`visible_frame_at`). Совпадает с Chromium.
- Выравнивание меню от кнопки по краю плашки, `start` и `end`. Совпадает с якорями `kTopLeft` и `kTopRight`.
- Порядок «сначала вниз, затем вверх» и ограничение высоты с прокруткой. Совпадает с порядком Chromium.
- Контекстное меню сдвигается вверх по вертикали (`shift_along`). Совпадает с документированным поведением `popUpContextMenu`.
- Подменю: вправо, при нехватке влево, сторона выбирается один раз при открытии панели. Совпадает с Chromium; у Mine один уровень подменю, как советует руководство.
- Окно: уровень 101 и `CanJoinAllSpaces | Transient | IgnoresCycle | FullScreenAuxiliary`. Совпадает с рекомендациями отчётов, проверка нужна.
- Зазор 4 px от плашки кнопки — решение пользователя, источники ему не противоречат.

### 5.4 Что заменить

- **Поле 8 px от края экрана** ([geometry.rs, `EDGE_PX`](file:///Users/i_iii/Проекты/Личные%20проекты/local-arena/.claude/worktrees/youtube-referer/src-tauri/src/menu_panel/geometry.rs), `FLOATING_LAYER_EDGE_PX`). Заменить на 0 относительно видимой области. Основание: правило 2.
- **Смещение контекстного меню от указателя 2 px** (`CONTEXT_MENU_OFFSET_PX`). Заменить на 0: документация AppKit ставит угол меню в точку события.
- **Источник верхней границы.** Добавить вычитание `safeAreaInsets.top` в полноэкранном режиме (правило 5). Сейчас берётся только `visibleFrame` ([native.rs, `visible_frame_at`](file:///Users/i_iii/Проекты/Личные%20проекты/local-arena/.claude/worktrees/youtube-referer/src-tauri/src/menu_panel/native.rs)).
- **Название правил.** Описание в `geometry.rs`, `DESIGN_SYSTEM.md` и `ARCHITECTURE.md` («по правилам Radix») заменить описанием по этому документу: Radix остаётся механизмом внутри страницы панели (подменю), но решение о стороне и сдвиге принимает бэкенд по правилам выше.
- **Не заменять.** Выбор «наименьшего переполнения» при нехватке места с обеих сторон (`bestFit`) эквивалентен Chromium: меню занимает сторону с большим местом и прокручивается.

## 6. Решения за пользователем

| № | Решение | Рекомендация | Довод |
|---|---|---|---|
| 1 | Поле до края экрана: 0 или оставить 8 px | 0 | Ни Apple, ни Chromium поля не задают, 8 px пришло с веба |
| 2 | Меню выбора значения (переключатель пространства): поверх кнопки, как AppKit, или под ней | Под кнопкой | Накрывающее положение требует отдельного расчёта у края экрана (Chromium от него отказался), а выгода есть только у чистого выбора значения |
| 3 | Контекстное меню у правого края: переворот влево или сдвиг внутрь | Переворот влево, как сейчас | Firefox описывает системное контекстное меню как переворачивающееся; Chromium сдвигает; источники расходятся |
| 4 | Стрелки прокрутки как у системного меню или текущий вид | Текущий вид | Стрелки нужны только Connect со списком коллекций; цена выше пользы |
| 5 | Что делать, если окно не показывается поверх полноэкранного | Перейти на `NSPanel` без активации | Совет форумов Apple; решается при проверке реализации |

Пояснения.

- **Решение 2.** Если в меню пространства останется только выбор значения, по [HIG](https://developer.apple.com/design/human-interface-guidelines/pop-up-buttons) это pop-up button. Состав меню пространства я не проверял. Если в нём только выбор значения, оно по HIG pop-up button, и «поверх кнопки» становится нативным вариантом; рекомендация «под кнопкой» остаётся из-за цены расчёта.
- **Решение 3.** Рекомендация держится на одной фразе Firefox и на документированном «moved up» для вертикали. Поведение горизонтали у системного контекстного меню в источниках не описано. Если проверка на реальном экране покажет сдвиг без переворота, рекомендация сменится на сдвиг, как у Chromium.

**Решения пользователя 15.11.2026.** Пользователь принял все пять решений по рекомендации: поле до края экрана 0; меню пространства под кнопкой; контекстное меню у правого края переворачивается влево; прокрутка в нынешнем виде, без системных стрелок; если окно меню не показывается поверх полноэкранного, оно заменяется панелью `NSPanel` без активации. В тот же день пользователь решил перевести все меню приложения в отдельное окно, как меню карточки в пробе. Требования и план: [SPEC_MENU_WINDOW.md](SPEC_MENU_WINDOW.md).

**Пересмотр 16.11.2026.** Решение 6 (меню от кнопки выровнено по её краю, у кнопки справа по правому) пересмотрено пользователем: меню от любой кнопки открывается вправо и вниз, у правого края экрана переворачивается ([SPEC_MENU_WINDOW.md](SPEC_MENU_WINDOW.md), МО7).

## 7. Что установить не удалось

- Зазор системного pull-down от кнопки и поле системного меню до края экрана: не документированы и не измерены.
- Сторона подменю у системного меню у правого края экрана: документации нет, есть косвенный отчёт о баге Firefox.
- Поведение меню в Split View: документации нет.
- Горизонтальное поведение системного контекстного меню у правого края: документации нет.
- Экран, на котором откроется меню, если окно лежит на двух экранах: документации нет, правило выведено из Chromium.
- Причина, по которой Chromium выбрал рабочую область экрана границей: в коде не записана.
- Работоспособность связки уровня окна и `fullScreenAuxiliary` на текущей версии macOS: отчёты расходятся.

## 8. Источники

Apple, руководство: [Menus](https://developer.apple.com/design/human-interface-guidelines/menus), [Pull-down buttons](https://developer.apple.com/design/human-interface-guidelines/pull-down-buttons), [Pop-up buttons](https://developer.apple.com/design/human-interface-guidelines/pop-up-buttons), [Context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus), [Going full screen](https://developer.apple.com/design/human-interface-guidelines/going-full-screen), [Popovers](https://developer.apple.com/design/human-interface-guidelines/popovers), [Multitasking](https://developer.apple.com/design/human-interface-guidelines/multitasking), [Mac OS 8 HIG, Pop-up menus](https://discmaster.textfiles.com/file/32774/Dev.CD%20Dec%2098%20RL2.toast/Technical%20Publications/mac/HIGuidelines/HIGuidelines-91.html?html=true).

Apple, документация и заголовки SDK: [NSMenu](https://developer.apple.com/documentation/appkit/nsmenu), [popUp(positioning:at:in:)](https://developer.apple.com/documentation/appkit/nsmenu/popup(positioning:at:in:)), [popUpContextMenu](https://developer.apple.com/documentation/appkit/nsmenu/popupcontextmenu(_:with:for:)), [NSPopUpButton.preferredEdge](https://developer.apple.com/documentation/appkit/nspopupbutton/preferrededge), [NSPopover.show](https://developer.apple.com/documentation/appkit/nspopover/show(relativeto:of:preferrededge:)), [NSScreen.visibleFrame](https://developer.apple.com/documentation/appkit/nsscreen/visibleframe), [NSScreen.safeAreaInsets](https://developer.apple.com/documentation/appkit/nsscreen/safeareainsets), [CollectionBehavior](https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior-swift.struct), [fullScreenAuxiliary](https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior-swift.struct/fullscreenauxiliary). Комментарии к `popUpContextMenu`, `popUpMenuPositioningItem`, `confinementRectForMenu:onScreen:` и `preferredEdge` прочитаны в заголовках `NSMenu.h`, `NSPopUpButton.h`, `NSPopUpButtonCell.h` из SDK Xcode на этом компьютере.

Chromium (ветка main, 15.11.2026): [menu_controller.cc](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_controller.cc), [menu_types.h](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_types.h), [menu_config.h](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_config.h), [menu_runner.cc](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_runner.cc), [menu_runner_impl_cocoa.mm](https://chromium.googlesource.com/chromium/src/+/main/ui/views/controls/menu/menu_runner_impl_cocoa.mm), [app_menu.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/views/toolbar/app_menu.cc), [web_menu_runner_mac.mm](https://chromium.googlesource.com/chromium/src/+/main/content/app_shim_remote_cocoa/web_menu_runner_mac.mm). Номера строк относятся к копии файлов от 15.11.2026 и со временем сдвинутся.

Firefox и отчёты разработчиков: [MOZMenuOpeningCoordinator.mm](https://searchfox.org/firefox-main/source/widget/cocoa/MOZMenuOpeningCoordinator.mm), [Mozilla bug 367260](https://bugzilla.mozilla.org/show_bug.cgi?id=367260), [bug 1648881](https://bugzilla.mozilla.org/show_bug.cgi?id=1648881), [bug 1707869](https://bugzilla.mozilla.org/show_bug.cgi?id=1707869), [Apple Developer Forums 826308](https://developer.apple.com/forums/thread/826308), [800091](https://developer.apple.com/forums/thread/800091), [26677](https://developer.apple.com/forums/thread/26677), [106894](https://developer.apple.com/forums/thread/106894), [samlu PR 10](https://github.com/samreshan/samlu/pull/10), [standlock PR 40](https://github.com/yagizdo/standlock/pull/40). Содержимое тем форума Apple прочитано в пересказах поисковой системы, потому что страницы форума рисуются скриптами и не читаются напрямую.

Проект: [DESIGN_SYSTEM.md](file:///Users/i_iii/Проекты/Личные%20проекты/local-arena/.claude/worktrees/youtube-referer/DESIGN_SYSTEM.md) (разделы «Отступ от кнопки», «Выравнивание», «Системные меню: отклонённый эксперимент», «Меню карточки в отдельном окне: проба»), [ARCHITECTURE.md](file:///Users/i_iii/Проекты/Личные%20проекты/local-arena/.claude/worktrees/youtube-referer/ARCHITECTURE.md) (решение 072), [geometry.rs](file:///Users/i_iii/Проекты/Личные%20проекты/local-arena/.claude/worktrees/youtube-referer/src-tauri/src/menu_panel/geometry.rs), [native.rs](file:///Users/i_iii/Проекты/Личные%20проекты/local-arena/.claude/worktrees/youtube-referer/src-tauri/src/menu_panel/native.rs), [menuPanelGeometry.ts](file:///Users/i_iii/Проекты/Личные%20проекты/local-arena/.claude/worktrees/youtube-referer/src/lib/menuPanelGeometry.ts).
