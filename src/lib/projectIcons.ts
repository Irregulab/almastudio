/**
 * Icons a project can use instead of an emoji: the same Lucide set the rest of
 * the app is drawn with, so a project sits in the sidebar like everything else
 * does, in its own colour. Stored by name, so the list can change without
 * touching saved projects — a name no longer listed falls back to the emoji.
 */
import type { LucideIcon } from 'lucide-react'
import {
  Atom, BarChart3, Blocks, BookOpen, Bot, Brain, Briefcase, Bug, Building2, Camera,
  Cloud, Code2, Container, Cpu, Database, Factory, FlaskConical, Gamepad2, Globe,
  GraduationCap, HardDrive, Heart, House, Layers, Leaf, Lightbulb, Lock, Mail,
  Map as MapIcon, Monitor, Music, Network, Package, Palette, PenTool, Rocket, Server,
  Shield, ShoppingCart, Smartphone, Sparkles, SquareTerminal, Store, Target, Truck,
  Users, Wallet, Workflow, Wrench, Zap,
} from 'lucide-react'

export const PROJECT_ICONS: Record<string, LucideIcon> = {
  Code2, SquareTerminal, Globe, Server, Database, Cloud, Smartphone, Monitor, Cpu, Container,
  Network, HardDrive, Package, Blocks, Layers, Workflow, Rocket, Wrench, Bug, FlaskConical,
  Atom, Brain, Bot, Sparkles, Shield, Lock, BarChart3, ShoppingCart, Store, Wallet,
  Briefcase, Building2, Factory, Truck, Users, Mail, BookOpen, GraduationCap, Palette, PenTool,
  Music, Camera, Gamepad2, Map: MapIcon, House, Leaf, Heart, Lightbulb, Target, Zap,
}

export const PROJECT_ICON_NAMES = Object.keys(PROJECT_ICONS)
