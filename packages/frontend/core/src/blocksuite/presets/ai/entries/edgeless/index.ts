import type {
  AIItemGroupConfig,
  EdgelessCopilotWidget,
  EdgelessElementToolbarWidget,
  EdgelessRootBlockComponent,
} from '@blocksuite/blocks';
import { EdgelessCopilotToolbarEntry } from '@blocksuite/blocks';
import { noop } from '@blocksuite/global/utils';
import { html } from 'lit';

import { edgelessActionGroups } from './actions-config';

noop(EdgelessCopilotToolbarEntry);

export function setupEdgelessCopilot(widget: EdgelessCopilotWidget) {
  widget.groups = edgelessActionGroups;
}

export function setupEdgelessElementToolbarEntry(
  widget: EdgelessElementToolbarWidget
) {
  widget.registerEntry({
    when: () => {
      return true;
    },
    render: (edgeless: EdgelessRootBlockComponent) => {
      const chain = edgeless.service.std.command.chain();
      const filteredGroups = edgelessActionGroups.reduce((pre, group) => {
        const filtered = group.items.filter(item =>
          item.showWhen?.(chain, 'edgeless', edgeless.host)
        );

        if (filtered.length > 0) pre.push({ ...group, items: filtered });

        return pre;
      }, [] as AIItemGroupConfig[]);

      if (filteredGroups.every(group => group.items.length === 0)) return null;

      return html`<edgeless-copilot-toolbar-entry
        .edgeless=${edgeless}
        .host=${edgeless.host}
        .groups=${edgelessActionGroups}
      ></edgeless-copilot-toolbar-entry>`;
    },
  });
}
