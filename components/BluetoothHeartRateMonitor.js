import { Buffer } from 'buffer';
import { Alert, PermissionsAndroid, Platform } from 'react-native';
import { BleManager } from 'react-native-ble-plx';

const HEART_RATE_SERVICE_UUID = '0000180d-0000-1000-8000-00805f9b34fb';
const HEART_RATE_MEASUREMENT_UUID = '00002a37-0000-1000-8000-00805f9b34fb';

const DEFAULT_OPTIONS = {
  heartRateMin: 30,
  heartRateMax: 220,
  scanTimeoutMs: 12000,
  serviceUUIDs: [HEART_RATE_SERVICE_UUID],
  onConnectionStateChange: null,
  onScanningChange: null,
  onDeviceNameChange: null,
  onHeartRate: null,
};

export class BluetoothHeartRateMonitor {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.bleManager = new BleManager();

    this.connectedDevice = null;
    this.isScanning = false;

    this.scanTimeoutId = null;
    this.charSubscription = null;
    this.deviceDisconnectedSubscription = null;
    this.stateSubscription = null;
    this.ensureOnTimeoutId = null;

    this._destroyed = false;
  }

  async start() {
    await this.startScan();
  }

  async destroy() {
    this._destroyed = true;
    this._clearScanTimeout();
    this._clearEnsureOnTimeout();
    this.stateSubscription?.remove();
    this.stateSubscription = null;
    this._unsubConnectedDevice();

    await this.stopScan();

    if (this.connectedDevice) {
      try {
        if (await this.bleManager.isDeviceConnected(this.connectedDevice.id)) {
          await this.bleManager.cancelDeviceConnection(this.connectedDevice.id);
        }
      } catch (error) {
        console.log('清理连接时出错:', error?.message);
      }
    }

    try {
      await this.bleManager.destroy();
    } catch (error) {
      console.log('销毁 BleManager 失败:', error?.message);
    }
  }

  async rescan() {
    await this.stopScan();
    await this.disconnect();
    this._emitDeviceName(null);
    this._emitHeartRate(null);
    setTimeout(() => {
      this.startScan();
    }, 300);
  }

  async disconnect() {
    this._unsubConnectedDevice();
    if (!this.connectedDevice) {
      return;
    }

    try {
      if (await this.bleManager.isDeviceConnected(this.connectedDevice.id)) {
        await this.bleManager.cancelDeviceConnection(this.connectedDevice.id);
      }
    } catch (error) {
      if (!error?.message?.includes('Device') && !error?.message?.includes('already')) {
        Alert.alert('主动断开连接错误', error?.message ?? '主动断开连接出现问题');
      }
    } finally {
      this.connectedDevice = null;
    }
  }

  async startScan() {
    this._unsubConnectedDevice();

    if (this.isScanning) {
      return;
    }

    const permissionGranted = await this._requestPermission();
    if (!permissionGranted) {
      this._emitConnectionState('permission_denied');
      Alert.alert('权限不足', '需要蓝牙与位置权限以扫描设备');
      return;
    }

    try {
      await this._ensureBluetoothOn();
    } catch (error) {
      this._emitConnectionState('bluetooth_off');
      Alert.alert('蓝牙不可用', '请开启蓝牙后重试');
      return;
    }

    this._emitConnectionState('scanning');
    this._setScanningState(true);

    this.bleManager.startDeviceScan(this.options.serviceUUIDs, null, (error, device) => {
      if (this._destroyed) {
        return;
      }
      if (error) {
        (async () => {
          await this.stopScan();
        })();
        this._emitConnectionState('scan_error');
        Alert.alert('扫描失败', error?.message ?? '扫描出现问题');
        return;
      }
      if (device?.name || device?.localName) {
        (async () => {
          await this.stopScan();
        })();
        this._emitConnectionState('connecting');
        this._connectAndMonitor(device);
      }
    });

    this._clearScanTimeout();
    this.scanTimeoutId = setTimeout(async () => {
      if (!this.isScanning || this._destroyed) {
        return;
      }
      await this.stopScan();
      this._emitConnectionState('no_device');
    }, this.options.scanTimeoutMs);
  }

  async stopScan() {
    this._unsubConnectedDevice();
    this._clearScanTimeout();

    try {
      await this.bleManager.stopDeviceScan();
    } catch (error) {
      console.log('停止扫描失败:', error?.message);
    } finally {
      this._setScanningState(false);
    }
  }

  async _connectAndMonitor(device) {
    try {
      const connectedDevice = await device.connect();
      this.connectedDevice = connectedDevice;
      this._emitDeviceName(device.name || device.localName || '未知设备');
      this._emitConnectionState('connected');

      await connectedDevice.discoverAllServicesAndCharacteristics();

      this.deviceDisconnectedSubscription?.remove();
      this.deviceDisconnectedSubscription = this.bleManager.onDeviceDisconnected(
        device.id,
        this._handleDisconnection
      );

      this.charSubscription?.remove();
      this.charSubscription = connectedDevice.monitorCharacteristicForService(
        HEART_RATE_SERVICE_UUID,
        HEART_RATE_MEASUREMENT_UUID,
        this._handleBleCharacteristic
      );
    } catch (error) {
      this._emitConnectionState('connect_error');
      Alert.alert('连接失败', error?.message ?? '连接出现问题');
      await this.startScan();
    }
  }

  _handleBleCharacteristic = (error, characteristic) => {
    if (this._destroyed) {
      return;
    }
    if (error) {
      const msg = String(error?.message ?? '').toLowerCase();
      if (
        msg.includes('cancelled') ||
        msg.includes('device disconnected') ||
        msg.includes('gatt') ||
        msg.includes('terminated')
      ) {
        return;
      }
      this._emitConnectionState('monitor_error');
      return;
    }
    if (!characteristic?.value) {
      return;
    }
    const parsed = this._parseHeartRate(characteristic.value);
    if (parsed === null) {
      return;
    }
    this._emitHeartRate(parsed);
  };

  _handleDisconnection = async (error, device) => {
    if (this._destroyed) {
      return;
    }
    if (error) {
      console.log(`设备${device?.id || '未知'}断开连接错误:`, error);
    }

    this._unsubConnectedDevice();

    try {
      if (device?.id && (await this.bleManager.isDeviceConnected(device.id))) {
        await this.bleManager.cancelDeviceConnection(device.id);
      } else {
        await this.stopScan();
      }
    } catch (error) {
      console.log('断开连接清理失败:', error?.message);
    }

    this.connectedDevice = null;
    this._emitConnectionState('disconnected');
    this._emitDeviceName(null);
    this._emitHeartRate(null);
  };

  _unsubConnectedDevice() {
    this.charSubscription?.remove();
    this.charSubscription = null;
    this.deviceDisconnectedSubscription?.remove();
    this.deviceDisconnectedSubscription = null;
  }

  async _requestPermission() {
    if (Platform.OS !== 'android') {
      return true;
    }
    try {
      if (Platform.Version >= 31) {
        const permissions = [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ];
        const result = await PermissionsAndroid.requestMultiple(permissions);
        return permissions.every(
          (permission) => result[permission] === PermissionsAndroid.RESULTS.GRANTED
        );
      }
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
      );
      return result === PermissionsAndroid.RESULTS.GRANTED;
    } catch (error) {
      return false;
    }
  }

  _ensureBluetoothOn() {
    this._clearEnsureOnTimeout();
    this.stateSubscription?.remove();
    this.stateSubscription = null;

    return new Promise((resolve, reject) => {
      this.ensureOnTimeoutId = setTimeout(() => {
        this.stateSubscription?.remove();
        this.stateSubscription = null;
        reject(new Error('Bluetooth unavailable'));
      }, 7000);

      this.stateSubscription = this.bleManager.onStateChange((state) => {
        if (this._destroyed) {
          this.stateSubscription?.remove();
          this.stateSubscription = null;
          return;
        }
        if (state === 'PoweredOn') {
          this._clearEnsureOnTimeout();
          this.stateSubscription?.remove();
          this.stateSubscription = null;
          resolve(true);
        } else if (state === 'PoweredOff' || state === 'Unauthorized') {
          this._emitConnectionState('bluetooth_off');
        }
      }, true);
    });
  }

  _parseHeartRate(base64Value) {
    try {
      const buffer = Buffer.from(base64Value, 'base64');
      if (buffer.length < 2) {
        return null;
      }
      const flags = buffer.readUInt8(0);
      const is16Bit = (flags & 0x01) === 1;
      const value = is16Bit ? buffer.readUInt16LE(1) : buffer.readUInt8(1);
      if (value < this.options.heartRateMin || value > this.options.heartRateMax) {
        return null;
      }
      return value;
    } catch (error) {
      return null;
    }
  }

  _setScanningState(value) {
    this.isScanning = value;
    if (typeof this.options.onScanningChange === 'function') {
      this.options.onScanningChange(value);
    }
  }

  _emitConnectionState(state) {
    if (typeof this.options.onConnectionStateChange === 'function') {
      this.options.onConnectionStateChange(state);
    }
  }

  _emitDeviceName(name) {
    if (typeof this.options.onDeviceNameChange === 'function') {
      this.options.onDeviceNameChange(name);
    }
  }

  _emitHeartRate(rate) {
    if (typeof this.options.onHeartRate === 'function') {
      this.options.onHeartRate(rate);
    }
  }

  _clearScanTimeout() {
    if (this.scanTimeoutId) {
      clearTimeout(this.scanTimeoutId);
      this.scanTimeoutId = null;
    }
  }

  _clearEnsureOnTimeout() {
    if (this.ensureOnTimeoutId) {
      clearTimeout(this.ensureOnTimeoutId);
      this.ensureOnTimeoutId = null;
    }
  }
}
