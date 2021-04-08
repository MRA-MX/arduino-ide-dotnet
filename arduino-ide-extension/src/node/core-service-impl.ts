import { FileUri } from '@theia/core/lib/node/file-uri';
import { inject, injectable } from 'inversify';
import { relative } from 'path';
import * as jspb from 'google-protobuf';
import { CompilerWarnings, CoreService } from '../common/protocol/core-service';
import { CompileRequest, CompileResponse } from './cli-protocol/cc/arduino/cli/commands/v1/compile_pb';
import { CoreClientAware } from './core-client-provider';
import { BurnBootloaderRequest, BurnBootloaderResponse, UploadRequest, UploadResponse, UploadUsingProgrammerRequest, UploadUsingProgrammerResponse } from './cli-protocol/cc/arduino/cli/commands/v1/upload_pb';
import { OutputService } from '../common/protocol/output-service';
import { NotificationServiceServer } from '../common/protocol';
import { ClientReadableStream } from '@grpc/grpc-js';
import { ArduinoCoreServiceClient } from './cli-protocol/cc/arduino/cli/commands/v1/commands_grpc_pb';
import { firstToUpperCase, firstToLowerCase } from '../common/utils';
import { BoolValue } from 'google-protobuf/google/protobuf/wrappers_pb';

@injectable()
export class CoreServiceImpl extends CoreClientAware implements CoreService {

    @inject(OutputService)
    protected readonly outputService: OutputService;

    @inject(NotificationServiceServer)
    protected readonly notificationService: NotificationServiceServer;

    async compile(options: CoreService.Compile.Options & { exportBinaries?: boolean, compilerWarnings?: CompilerWarnings }): Promise<void> {
        const { sketchUri, fqbn, compilerWarnings } = options;
        const sketchPath = FileUri.fsPath(sketchUri);

        const coreClient = await this.coreClient();
        const { client, instance } = coreClient;

        const compileReq = new CompileRequest();
        compileReq.setInstance(instance);
        compileReq.setSketchPath(sketchPath);
        if (fqbn) {
            compileReq.setFqbn(fqbn);
        }
        if (compilerWarnings) {
            compileReq.setWarnings(compilerWarnings.toLowerCase());
        }
        compileReq.setOptimizeForDebug(options.optimizeForDebug);
        compileReq.setPreprocess(false);
        compileReq.setVerbose(options.verbose);
        compileReq.setQuiet(false);
        if (typeof options.exportBinaries === 'boolean') {
            const exportBinaries = new BoolValue();
            exportBinaries.setValue(options.exportBinaries);
            compileReq.setExportBinaries(exportBinaries);
        }
        this.mergeSourceOverrides(compileReq, options);

        const result = client.compile(compileReq);
        try {
            await new Promise<void>((resolve, reject) => {
                result.on('data', (cr: CompileResponse) => {
                    this.outputService.append({ chunk: Buffer.from(cr.getOutStream_asU8()).toString() });
                    this.outputService.append({ chunk: Buffer.from(cr.getErrStream_asU8()).toString() });
                });
                result.on('error', error => reject(error));
                result.on('end', () => resolve());
            });
            this.outputService.append({ chunk: '\n--------------------------\nCompilation complete.\n' });
        } catch (e) {
            this.outputService.append({ chunk: `Compilation error: ${e}\n`, severity: 'error' });
            throw e;
        }
    }

    async upload(options: CoreService.Upload.Options): Promise<void> {
        await this.doUpload(options, () => new UploadRequest(), (client, req) => client.upload(req));
    }

    async uploadUsingProgrammer(options: CoreService.Upload.Options): Promise<void> {
        await this.doUpload(options, () => new UploadUsingProgrammerRequest(), (client, req) => client.uploadUsingProgrammer(req), 'upload using programmer');
    }

    protected async doUpload(
        options: CoreService.Upload.Options,
        requestProvider: () => UploadRequest | UploadUsingProgrammerRequest,
        // tslint:disable-next-line:max-line-length
        responseHandler: (client: ArduinoCoreServiceClient, req: UploadRequest | UploadUsingProgrammerRequest) => ClientReadableStream<UploadResponse | UploadUsingProgrammerResponse>,
        task: string = 'upload'): Promise<void> {

        await this.compile(Object.assign(options, { exportBinaries: false }));
        const { sketchUri, fqbn, port, programmer } = options;
        const sketchPath = FileUri.fsPath(sketchUri);

        const coreClient = await this.coreClient();
        const { client, instance } = coreClient;

        const req = requestProvider();
        req.setInstance(instance);
        req.setSketchPath(sketchPath);
        if (fqbn) {
            req.setFqbn(fqbn);
        }
        if (port) {
            req.setPort(port);
        }
        if (programmer) {
            req.setProgrammer(programmer.id);
        }
        req.setVerbose(options.verbose);
        req.setVerify(options.verify);
        const result = responseHandler(client, req);

        try {
            await new Promise<void>((resolve, reject) => {
                result.on('data', (resp: UploadResponse) => {
                    this.outputService.append({ chunk: Buffer.from(resp.getOutStream_asU8()).toString() });
                    this.outputService.append({ chunk: Buffer.from(resp.getErrStream_asU8()).toString() });
                });
                result.on('error', error => reject(error));
                result.on('end', () => resolve());
            });
            this.outputService.append({ chunk: '\n--------------------------\n' + firstToLowerCase(task) + ' complete.\n' });
        } catch (e) {
            this.outputService.append({ chunk: `${firstToUpperCase(task)} error: ${e}\n`, severity: 'error' });
            throw e;
        }
    }

    async burnBootloader(options: CoreService.Bootloader.Options): Promise<void> {
        const coreClient = await this.coreClient();
        const { client, instance } = coreClient;
        const { fqbn, port, programmer } = options;
        const burnReq = new BurnBootloaderRequest();
        burnReq.setInstance(instance);
        if (fqbn) {
            burnReq.setFqbn(fqbn);
        }
        if (port) {
            burnReq.setPort(port);
        }
        if (programmer) {
            burnReq.setProgrammer(programmer.id);
        }
        burnReq.setVerify(options.verify);
        burnReq.setVerbose(options.verbose);
        const result = client.burnBootloader(burnReq);
        try {
            await new Promise<void>((resolve, reject) => {
                result.on('data', (resp: BurnBootloaderResponse) => {
                    this.outputService.append({ chunk: Buffer.from(resp.getOutStream_asU8()).toString() });
                    this.outputService.append({ chunk: Buffer.from(resp.getErrStream_asU8()).toString() });
                });
                result.on('error', error => reject(error));
                result.on('end', () => resolve());
            });
        } catch (e) {
            this.outputService.append({ chunk: `Error while burning the bootloader: ${e}\n`, severity: 'error' });
            throw e;
        }
    }

    private mergeSourceOverrides(req: { getSourceOverrideMap(): jspb.Map<string, string> }, options: CoreService.Compile.Options): void {
        const sketchPath = FileUri.fsPath(options.sketchUri);
        for (const uri of Object.keys(options.sourceOverride)) {
            const content = options.sourceOverride[uri];
            if (content) {
                const relativePath = relative(sketchPath, FileUri.fsPath(uri));
                req.getSourceOverrideMap().set(relativePath, content);
            }
        }
    }

}
