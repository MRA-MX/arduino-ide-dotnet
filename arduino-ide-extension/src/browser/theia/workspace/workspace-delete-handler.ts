import type { Widget } from '@phosphor/widgets';
import * as remote from '@theia/core/electron-shared/@electron/remote';
import { Dialog } from '@theia/core/lib/browser/dialogs';
import { NavigatableWidget } from '@theia/core/lib/browser/navigatable-types';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { nls } from '@theia/core/lib/common';
import type { MaybeArray } from '@theia/core/lib/common/types';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import { WorkspaceDeleteHandler as TheiaWorkspaceDeleteHandler } from '@theia/workspace/lib/browser/workspace-delete-handler';
import { SketchesService } from '../../../common/protocol';
import {
  CurrentSketch,
  SketchesServiceClientImpl,
} from '../../../common/protocol/sketches-service-client-impl';
import { Sketch } from '../../contributions/contribution';

@injectable()
export class WorkspaceDeleteHandler extends TheiaWorkspaceDeleteHandler {
  @inject(WindowService)
  private readonly windowService: WindowService;
  @inject(SketchesService)
  private readonly sketchesService: SketchesService;
  @inject(SketchesServiceClientImpl)
  private readonly sketchesServiceClient: SketchesServiceClientImpl;

  override async execute(uris: URI[]): Promise<void> {
    const sketch = await this.sketchesServiceClient.currentSketch();
    if (!CurrentSketch.isValid(sketch)) {
      return;
    }
    // Deleting the main sketch file.
    if (
      uris
        .map((uri) => uri.toString())
        .some((uri) => uri === sketch.mainFileUri)
    ) {
      const { response } = await remote.dialog.showMessageBox({
        title: nls.localize('vscode/fileActions/delete', 'Delete'),
        type: 'question',
        buttons: [Dialog.CANCEL, Dialog.OK],
        message: nls.localize(
          'theia/workspace/deleteCurrentSketch',
          'Do you want to delete the current sketch?'
        ),
      });
      if (response === 1) {
        // OK
        await Promise.all([
          ...Sketch.uris(sketch).map((uri) =>
            this.closeWithoutSaving(new URI(uri))
          ),
        ]);
        this.windowService.setSafeToShutDown();
        this.sketchesService.deleteSketch(sketch);
        return window.close();
      }
    }
    return super.execute(uris);
  }

  // https://github.com/eclipse-theia/theia/issues/12107
  protected override async closeWithoutSaving(uri: URI): Promise<void> {
    const affected = getAffected(this.shell.widgets, uri);
    const toClose = [...affected].map(([, widget]) => widget);
    await this.shell.closeMany(toClose, { save: false });
  }
}

export function getAffected<T extends Widget>(
  widgets: Iterable<T>,
  context: MaybeArray<URI>
): [URI, T & NavigatableWidget][] {
  const uris = Array.isArray(context) ? context : [context];
  const result: [URI, T & NavigatableWidget][] = [];
  for (const widget of widgets) {
    if (NavigatableWidget.is(widget)) {
      const resourceUri = widget.getResourceUri();
      if (resourceUri && uris.some((uri) => uri.isEqualOrParent(resourceUri))) {
        result.push([resourceUri, widget]);
      }
    }
  }
  return result;
}
