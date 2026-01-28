import { Buffer } from 'buffer';
import { activateKeepAwake, deactivateKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { BleManager } from 'react-native-ble-plx';

const manager = new BleManager();
const HEART_RATE_SERVICE_UUID = '0000180d-0000-1000-8000-00805f9b34fb';
const HEART_RATE_MEASUREMENT_UUID = '00002a37-0000-1000-8000-00805f9b34fb';
const HEART_RATE_MIN = 30;
const HEART_RATE_MAX = 220;
const SCAN_TIMEOUT_MS = 12000;
const HEART_ZONE_COLORS = ['#10B981', '#3B82F6', '#F59E0B', '#F97316', '#EF4444'];

export default function App() {
  const [heartRate, setHeartRate] = useState(null);
  const [connectionState, setConnectionState] = useState('idle');
  const [deviceName, setDeviceName] = useState(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);

  const pulse = useRef(new Animated.Value(1)).current;
  const colorProgress = useRef(new Animated.Value(0)).current;
  const connectedDeviceRef = useRef(null);
  const monitorSubRef = useRef(null);
  const disconnectSubRef = useRef(null);
  const scanTimeoutRef = useRef(null);
  const isScanningRef = useRef(false);

  const setScanningState = (value) => {
    isScanningRef.current = value;
    setIsScanning(value);
  };

  const requestPermission = async () => {
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
  };

  const ensureBluetoothOn = () =>
    new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Bluetooth unavailable'));
      }, 7000);
      const subscription = manager.onStateChange((state) => {
        if (state === 'PoweredOn') {
          clearTimeout(timeoutId);
          subscription.remove();
          resolve(true);
        } else if (state === 'PoweredOff' || state === 'Unauthorized') {
          setConnectionState('bluetooth_off');
        }
      }, true);
    });

  const parseHeartRate = (base64Value) => {
    try {
      const buffer = Buffer.from(base64Value, 'base64');
      if (buffer.length < 2) {
        return null;
      }
      const flags = buffer.readUInt8(0);
      const is16Bit = (flags & 0x01) === 1;
      const value = is16Bit ? buffer.readUInt16LE(1) : buffer.readUInt8(1);
      if (value < HEART_RATE_MIN || value > HEART_RATE_MAX) {
        return null;
      }
      return value;
    } catch (error) {
      return null;
    }
  };

  const stopScan = () => {
    manager.stopDeviceScan();
    if (scanTimeoutRef.current) {
      clearTimeout(scanTimeoutRef.current);
      scanTimeoutRef.current = null;
    }
    setScanningState(false);
  };

  const connectAndMonitor = async (device) => {
    try {
      const connectedDevice = await device.connect();
      connectedDeviceRef.current = connectedDevice;
      await connectedDevice.discoverAllServicesAndCharacteristics();
      setDeviceName(device.name || device.localName || '未知设备');
      setConnectionState('connected');
      disconnectSubRef.current?.remove();
      disconnectSubRef.current = connectedDevice.onDisconnected(() => {
        setConnectionState('disconnected');
        setDeviceName(null);
        setHeartRate(null);
        startScan();
      });
      monitorSubRef.current?.remove();
      monitorSubRef.current = connectedDevice.monitorCharacteristicForService(
        HEART_RATE_SERVICE_UUID,
        HEART_RATE_MEASUREMENT_UUID,
        (error, characteristic) => {
          if (error) {
            setConnectionState('monitor_error');
            return;
          }
          if (!characteristic?.value) {
            return;
          }
          const parsed = parseHeartRate(characteristic.value);
          if (parsed === null) {
            return;
          }
          setHeartRate(parsed);
        }
      );
    } catch (error) {
      setConnectionState('connect_error');
      Alert.alert('连接失败', error?.message ?? '连接出现问题');
      startScan();
    }
  };

  const startScan = async () => {
    if (isScanningRef.current) {
      return;
    }
    const permissionGranted = await requestPermission();
    if (!permissionGranted) {
      setConnectionState('permission_denied');
      Alert.alert('权限不足', '需要蓝牙与位置权限以扫描设备');
      return;
    }
    try {
      await ensureBluetoothOn();
    } catch (error) {
      setConnectionState('bluetooth_off');
      Alert.alert('蓝牙不可用', '请开启蓝牙后重试');
      return;
    }
    setConnectionState('scanning');
    setScanningState(true);
    manager.startDeviceScan([HEART_RATE_SERVICE_UUID], null, (error, device) => {
      if (error) {
        stopScan();
        setConnectionState('scan_error');
        Alert.alert('扫描失败', error?.message ?? '扫描出现问题');
        return;
      }
      if (device?.name || device?.localName) {
        stopScan();
        setConnectionState('connecting');
        connectAndMonitor(device);
      }
    });
    scanTimeoutRef.current = setTimeout(() => {
      if (!isScanningRef.current) {
        return;
      }
      stopScan();
      setConnectionState('no_device');
    }, SCAN_TIMEOUT_MS);
  };

  useEffect(() => {
    startScan();
    return () => {
      stopScan();
      monitorSubRef.current?.remove();
      disconnectSubRef.current?.remove();
      if (connectedDeviceRef.current) {
        connectedDeviceRef.current.cancelConnection().catch(() => null);
      }
      manager.destroy();
    };
  }, []);

  useEffect(() => {
    if (isFullScreen) {
      activateKeepAwake('heart-monitor');
    } else {
      deactivateKeepAwake('heart-monitor');
    }
  }, [isFullScreen]);

  useEffect(() => {
    const bpm = heartRate ?? 60;
    const duration = Math.min(2000, Math.max(300, Math.round(60000 / bpm)));
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1.15,
          duration: Math.round(duration * 0.4),
          useNativeDriver: false,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: Math.round(duration * 0.6),
          useNativeDriver: false,
        }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [heartRate, pulse]);

  const zoneIndex = useMemo(() => {
    if (heartRate === null) {
      return 0;
    }
    if (heartRate < 70) {
      return 0;
    }
    if (heartRate < 120) {
      return 1;
    }
    if (heartRate < 160) {
      return 2;
    }
    if (heartRate < 180) {
      return 3;
    }
    return 4;
  }, [heartRate]);

  useEffect(() => {
    Animated.timing(colorProgress, {
      toValue: zoneIndex,
      duration: 400,
      useNativeDriver: false,
    }).start();
  }, [zoneIndex, colorProgress]);

  const statusText = useMemo(() => {
    switch (connectionState) {
      case 'scanning':
        return '扫描中';
      case 'connecting':
        return '连接中';
      case 'connected':
        return '已连接';
      case 'no_device':
        return '未找到设备';
      case 'permission_denied':
        return '权限不足';
      case 'bluetooth_off':
        return '蓝牙未开启';
      case 'scan_error':
        return '扫描失败';
      case 'connect_error':
        return '连接失败';
      case 'monitor_error':
        return '监听中断';
      case 'disconnected':
        return '连接断开';
      default:
        return '准备中';
    }
  }, [connectionState]);

  const heartColor = colorProgress.interpolate({
    inputRange: [0, 1, 2, 3, 4],
    outputRange: HEART_ZONE_COLORS,
  });

  if (isFullScreen) {
    return (
      <Pressable style={styles.fullscreen} onPress={() => setIsFullScreen(false)}>
        <StatusBar style="light" hidden />
        <Animated.Text
          style={[
            styles.fullscreenHeart,
            { color: heartColor, transform: [{ scale: pulse }] },
          ]}
        >
          ❤
        </Animated.Text>
        <Text style={styles.fullscreenRate}>{heartRate ?? '--'}</Text>
        <Text style={styles.fullscreenUnit}>BPM</Text>
      </Pressable>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" hidden={false} />
      <View style={styles.header}>
        <Text style={styles.title}>Heart Monitor</Text>
        <View style={styles.statusRow}>
          <Text style={styles.statusText}>{statusText}</Text>
          {isScanning ? <ActivityIndicator size="small" color="#3B82F6" /> : null}
        </View>
        {deviceName ? <Text style={styles.deviceText}>{deviceName}</Text> : null}
      </View>
      <View style={styles.center}>
        <Animated.Text
          style={[styles.heartIcon, { color: heartColor, transform: [{ scale: pulse }] }]}
        >
          ❤
        </Animated.Text>
        <Text style={styles.rateValue}>{heartRate ?? '--'}</Text>
        <Text style={styles.rateUnit}>BPM</Text>
      </View>
      <View style={styles.footer}>
        <Pressable style={styles.primaryButton} onPress={() => setIsFullScreen(true)}>
          <Text style={styles.primaryButtonText}>全屏</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={startScan}>
          <Text style={styles.secondaryButtonText}>重新扫描</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  header: {
    paddingHorizontal: 24,
    paddingTop: 16,
    gap: 6,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#0F172A',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusText: {
    fontSize: 14,
    color: '#475569',
  },
  deviceText: {
    fontSize: 13,
    color: '#64748B',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  heartIcon: {
    fontSize: 72,
  },
  rateValue: {
    fontSize: 64,
    fontWeight: '700',
    color: '#0F172A',
  },
  rateUnit: {
    fontSize: 16,
    color: '#64748B',
    letterSpacing: 2,
  },
  footer: {
    paddingHorizontal: 24,
    paddingBottom: 28,
    gap: 12,
  },
  primaryButton: {
    backgroundColor: '#0F172A',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#F8FAFC',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: '#E2E8F0',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#0F172A',
    fontSize: 16,
    fontWeight: '600',
  },
  fullscreen: {
    flex: 1,
    backgroundColor: '#0B1120',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullscreenHeart: {
    fontSize: 120,
  },
  fullscreenRate: {
    marginTop: 12,
    fontSize: 96,
    fontWeight: '700',
    color: '#F8FAFC',
  },
  fullscreenUnit: {
    fontSize: 20,
    color: '#CBD5F5',
    letterSpacing: 3,
  },
});
