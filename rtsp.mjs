import ffmpeg from 'fluent-ffmpeg';
import net from 'net';
import { exec } from 'child_process';
import path from 'path';

const ffmpegPath = path.resolve('./ffmpeg.exe');
ffmpeg.setFfmpegPath(ffmpegPath);



const _sleep = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
}



class RTSPClient {
    constructor(host, port, uri, options = {}) {
        this.host = host;
        this.port = port;
        this.rtspUri = uri;
        this.options = options;
        this.fps = 50; // default
        this.frame = null;
        this.status = 'Stopped';
        this._stopEvent = false;
        this._reconnectInterval = null;
        this._socket = null;
        this._ffmpegProcess = null;
        this._stream = null;
    }

    async _getStreamFps() {
        // Custom implementation might be needed
        // this.fps = this.fps; // Placeholder
        console.info(`Stream FPS: ${this.fps}`);
    }

    async _open() {

        const handleError = (err) => {
            console.error(`FFmpeg error: ${err.message}`);
            if (this._ffmpegProcess) {
                this._ffmpegProcess.removeListener('error', handleError); // Remove the listener if it exists
            }
            _sleep(1000).then(() => this._reconnect());
        };

        while (!this._stopEvent) {
            try {
                if (this.host && this.port) {
                    await this._initSocket(this.host, this.port);
                }
                this._ffmpegProcess = ffmpeg(this.rtspUri)
                    .addOption('-f', 'image2pipe')
                    .addOption('-vf', `fps=${this.fps}`)
                    .videoCodec('mjpeg') // Specify MJPEG codec for JPEG encoding
                    .addOption('-q:v', '1') // Adjust quality (2 is a good balance between size and quality)
                    .format('image2pipe')
                    .on('error', handleError)

                this._ffmpegProcess.setMaxListeners(5); // Set max listeners limit

                this._stream = this._ffmpegProcess.pipe();
                // this._stream.setMaxListeners(2)
                await this._getStreamFps();
                console.info("Connected to stream");
                break;
            } catch (e) {
                console.error(`Failed to connect: ${e.message}`);
            } finally {
                await _sleep(1000);
            }
        }
    }

    async _close() {
        if (this._ffmpegProcess) {
            this._ffmpegProcess.kill();
            this._ffmpegProcess = null;
        }
        this.status = 'Stopped';
        this.frame = null;
        if (this._socket) {
            this._socket.destroy();
            this._socket = null;
        }
    }

    async _reconnect() {
        if (!this._ffmpegProcess) {
            console.info("Connecting...");
        } else {
            console.info("Connection lost, reconnecting...");
        }
        await this._close();
        await this._open();
    }

    async _readFrame(timeoutMs = 1000) {
        return new Promise((resolve, reject) => {
            let timer = setTimeout(() => {
                this._stream.removeListener('data', handleData);
                this._stream.removeListener('error', handleError);
                reject(new Error('Timeout while waiting for frame'));
            }, timeoutMs);
    
            const handleData = (chunk) => {
                clearTimeout(timer);
                this._stream.removeListener('error', handleError);
                resolve(chunk);
            };
    
            const handleError = (err) => {
                clearTimeout(timer);
                this._stream.removeListener('data', handleData);
                reject(new Error('Failed to read frame'));
            };
    
            this._stream.once('data', handleData);
            this._stream.once('error', handleError);
        });
    }

    // async _readFrame() {
    //     // TODO: add timeout
    //     return new Promise((resolve, reject) => {
    //         const handleData = async (chunk) => {
    //             this._stream.removeListener('error', handleError); // Remove the error listener
    //             resolve(chunk);
    //         };

    //         const handleError = (err) => {
    //             this._stream.removeListener('data', handleData); // Remove the data listener
    //             reject(new Error("Failed to read frame"));
    //         };

    //         this._stream.once('data', handleData);
    //         this._stream.once('error', handleError);
    //     });
    // }

    async runAsync() {
        try {
            console.info("Running RTSP client");
            await this._reconnect();
            while (!this._stopEvent) {
                try {
                    if (this._ffmpegProcess) {
                        const frame = await this._readFrame(1000);
                        this.status = 'Running';
                        this.frame = frame;
                        await _sleep(1000 / (this.fps * 2));
                    } else {
                        throw new Error("FFmpeg process not running");
                    }
                } catch (e) {
                    this.status = 'Error';
                    console.error(`${e.message}`);
                    await this._reconnect();
                }
            }
        } catch (e) {
            console.error(`RTSP client error: ${e.message}`);
        } finally {
            await this._close();
            console.info("RTSP client finalized");
        }
    }

    async stop() {
        console.info("RTSP client stop event set: True");
        this._stopEvent = true;
        if (this._reconnectInterval) {
            clearInterval(this._reconnectInterval);
        }
        await this._close();
    }

    // async _initSocket(host, port) {
    //     try {
    //         if (!(await this._ping(host))) {
    //             throw new Error("Host is not reachable");
    //         }

    //         this._socket = new net.Socket();
    //         this._socket.connect(port, host, () => {
    //             const initCommand = "CMD_RTSP_TRANS_START";
    //             this._socket.write(initCommand);
    //             this._socket.once('data', (data) => {
    //                 const response = data.toString();
    //                 console.info(`Response: ${response}`);
    //                 if (!response.includes("CMD_ACK_START_RTSP_LIVE")) {
    //                     throw new Error("Socket error");
    //                 }
    //             });
    //         });

    //         this._socket.on('error', (err) => {
    //             throw new Error(`Socket error: ${err.message}`);
    //         });
    //     } catch (error) {
    //         throw error;
    //     }
    // }

    async _initSocket(host, port) {
        try {
            if (!(await this._ping(host))) {
                throw new Error("Host is not reachable");
            }

            this._socket = new net.Socket();
            this._socket.connect(port, host, () => {
                const initCommand = "CMD_RTSP_TRANS_START";
                this._socket.write(initCommand);
                this._socket.once('data', (data) => {
                    const response = data.toString();
                    console.info(`Response: ${response}`);
                    if (!response.includes("CMD_ACK_START_RTSP_LIVE")) {
                        throw new Error("Socket error");
                    }
                });
            });

            this._socket.on('error', (err) => {
                if (err.code === 'ECONNRESET') {
                    console.error('Socket error: read ECONNRESET, reconnecting...');
                    this._reconnect(); // Handle ECONNRESET by reconnecting
                } else {
                    throw new Error(`Socket error: ${err.message}`);
                }
            });
        } catch (error) {
            throw error;
        }
    }

    async _ping(host) {
        return new Promise((resolve, reject) => {
            const pingCommand = process.platform === 'win32' ? `ping -n 1 ${host}` : `ping -c 1 ${host}`;
            exec(pingCommand, (error, stdout, stderr) => {
                if (error) {
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }
}

export default RTSPClient;
